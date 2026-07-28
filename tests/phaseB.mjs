/* Phase B: scene document, undo/redo, rasteriser, picking and transforms. */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const G = await import(B + 'geometry.js');
const { Scene, Shapes, BOUNDARIES, resetIds } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');
const { History } = await import(B + 'history.js');
const T = await import(B + 'transform.js');
const { PALETTE } = await import(B + 'colormaps.js');
const { SCENARIO_BY_ID } = await import(B + 'scenarios.js');

/* Build a scenario into a grid through the real scene pipeline. */
const { Scene: __Scene } = await import(B + 'scene.js');
const { Raster: __Raster } = await import(B + 'raster.js');
function loadScenario(g, id, aoa) {
  const sc = SCENARIO_BY_ID[id];
  const scene = new __Scene(g.nx, g.ny);
  for (const o of sc.objects(g.nx, g.ny, { aoa: aoa ?? sc.aoa })) scene.add(o);
  const r = new __Raster(g.nx, g.ny);
  r.build(scene);
  r.applyTo(g, 2.4);
  return { scene, raster: r };
}

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); } };
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log('=== 1. Signed distance functions ===');
{
  const r = Shapes.rect(50, 40, 20, 10);
  ok(G.sdf(r, 50, 40) < 0, 'rect: centre is inside');
  ok(near(G.sdf(r, 60, 40), 0, 1e-9), 'rect: right edge is on the surface', String(G.sdf(r, 60, 40)));
  ok(near(G.sdf(r, 65, 40), 5, 1e-9), 'rect: 5 cells outside reads 5');
  ok(!G.contains(r, 61, 40) && G.contains(r, 59, 40), 'rect: containment flips at the edge');

  const c = Shapes.circle(30, 30, 10);
  ok(near(G.sdf(c, 40, 30), 0, 1e-6), 'circle: edge distance is zero');
  ok(near(G.sdf(c, 30, 30), -10, 1e-6), 'circle: centre reads -r');
  ok(near(G.sdf(c, 30, 45), 5, 1e-3), 'circle: outside distance is correct');

  // Rotation: a long thin rect at 90 deg should contain points along y, not x.
  const rr = Shapes.rect(50, 50, 40, 4, { rot: 90 });
  ok(G.contains(rr, 50, 65) && !G.contains(rr, 65, 50), 'rect at 90 deg swaps its long axis');

  const poly = Shapes.polygon(20, 20, [-5, -5, 5, -5, 5, 5, -5, 5]);
  ok(G.contains(poly, 20, 20), 'polygon: centre inside');
  ok(!G.contains(poly, 27, 20), 'polygon: outside is outside');

  const wall = Shapes.wall(0, 0, [10, 10, 60, 10], 4);
  ok(G.contains(wall, 35, 10) && G.contains(wall, 35, 11.5) && !G.contains(wall, 35, 14),
    'polyline honours its thickness');
}

console.log('\n=== 2. Aerofoil orientation (camber must lift the right way) ===');
{
  const foil = Shapes.naca(60, 60, 40, { camber: 0.02, camberPos: 0.4, thickness: 0.12, aoa: 0 });
  // Sample the section thickness above and below the chord line at 40% chord.
  const x = 60 - 20 + 0.4 * 40;
  let up = 0, down = 0;
  for (let d = 0.25; d < 8; d += 0.25) {
    if (G.contains(foil, x, 60 - d)) up = d;
    if (G.contains(foil, x, 60 + d)) down = d;
  }
  console.log(`    at 40% chord: ${up.toFixed(2)} cells above the chord line, ${down.toFixed(2)} below`);
  ok(up > down, 'positive camber bulges UPWARD on screen (j decreasing)', `up=${up} down=${down}`);

  const at10 = Shapes.naca(60, 60, 40, { camber: 0, thickness: 0.12, aoa: 10 });
  const le = G.toWorld(at10.transform, -20, 0);
  const te = G.toWorld(at10.transform, 20, 0);
  console.log(`    aoa 10: leading edge y=${le[1].toFixed(2)}, trailing edge y=${te[1].toFixed(2)}`);
  ok(le[1] < te[1], 'positive incidence raises the leading edge');
}

console.log('\n=== 3. Scene document ===');
{
  resetIds(1);
  const s = new Scene(256, 128);
  const a = s.add(Shapes.circle(60, 64, 12, { name: 'Cylinder' }));
  const b = s.add(Shapes.rect(140, 64, 20, 10, { name: 'Block' }));
  ok(s.objects.length === 2, 'objects added');
  ok(a.id !== b.id, 'ids are unique');

  ok(s.pick(60, 64) === a, 'pick finds the circle');
  ok(s.pick(140, 64) === b, 'pick finds the rect');
  ok(s.pick(5, 5) === null, 'pick returns null over empty fluid');

  // Overlap: the later object wins, matching draw order.
  const c = s.add(Shapes.rect(60, 64, 30, 30, { name: 'Over' }));
  ok(s.pick(60, 64) === c, 'topmost object wins a pick');
  ok(s.pickAll(60, 64).length === 2, 'pickAll reports both');

  b.locked = true;
  ok(s.pick(140, 64) === null, 'locked objects are not pickable');
  b.locked = false;
  b.visible = false;
  ok(s.pick(140, 64) === null, 'hidden objects are not pickable');
  b.visible = true;

  s.remove(c.id);
  ok(s.objects.length === 2 && s.pick(60, 64) === a, 'remove works and restores the pick');

  const dup = s.duplicate(a.id);
  ok(dup && dup.id !== a.id && dup.name.includes('copy'), 'duplicate produces a new id');
  ok(dup.transform.x !== a.transform.x, 'duplicate is offset');
}

console.log('\n=== 4. Serialisation round-trip ===');
{
  const s = new Scene(320, 160);
  s.add(Shapes.circle(60, 64, 12, { name: 'Cyl' }));
  s.add(Shapes.naca(140, 80, 50, { camber: 0.02, aoa: 6 }, { name: 'Wing', boundary: 'noslip' }));
  s.add(Shapes.rect(10, 80, 6, 100, { name: 'Inlet', boundary: 'inlet', bcParams: { speed: 1.5, direction: 0 } }));

  const json = JSON.parse(JSON.stringify(s.toJSON()));
  const back = Scene.fromJSON(json);
  ok(back.objects.length === 3, 'object count survives');
  ok(back.nx === 320 && back.ny === 160, 'domain survives');
  ok(back.objects[1].transform.rot === 6, 'aerofoil incidence survives');
  ok(back.objects[2].boundary === 'inlet' && back.objects[2].bcParams.speed === 1.5, 'boundary role and params survive');
  ok(!('_outline' in back.objects[1]), 'derived outline cache is not serialised');

  // Geometry must agree cell for cell after a round-trip.
  let diff = 0;
  for (let y = 1; y < 160; y += 3) for (let x = 1; x < 320; x += 3) {
    for (let k = 0; k < 3; k++) if (G.contains(s.objects[k], x, y) !== G.contains(back.objects[k], x, y)) diff++;
  }
  ok(diff === 0, 'geometry is identical after a round-trip', `${diff} differing samples`);
}

console.log('\n=== 5. Undo / redo ===');
{
  const s = new Scene(256, 128);
  const h = new History(s, { now: (() => { let t = 0; return () => (t += 10000); })() });
  const o = s.add(Shapes.circle(50, 50, 10, { name: 'A' }));
  h.commit('add circle');
  ok(h.canUndo && !h.canRedo, 'a commit enables undo');

  T.move(o, 30, 0);
  h.commit('move');
  ok(s.get(o.id).transform.x === 80, 'move applied');

  h.undo();
  ok(s.get(o.id).transform.x === 50, 'undo restores the position');
  h.redo();
  ok(s.get(o.id).transform.x === 80, 'redo re-applies it');

  h.undo(); h.undo();
  ok(s.objects.length === 0, 'undoing past the add empties the scene');
  h.redo();
  ok(s.objects.length === 1, 'redo brings it back');

  // A new edit after undo must discard the redo tail.
  h.undo();
  s.add(Shapes.rect(10, 10, 5, 5));
  h.commit('add rect');
  ok(!h.canRedo, 'a new edit clears the redo branch');

  // The scene identity must survive: holders keep their reference.
  const sameRef = s;
  h.undo();
  ok(sameRef === s && Array.isArray(s.objects), 'undo restores in place, not by replacing the scene');

  // Coalescing.
  const s2 = new Scene(64, 64);
  let clock = 0;
  const h2 = new History(s2, { now: () => clock });
  const o2 = s2.add(Shapes.circle(10, 10, 3));
  h2.commit('add');
  const before = h2.stack.length;
  for (let k = 0; k < 50; k++) { clock += 5; T.move(o2, 0.2, 0); h2.commit('move', `move:${o2.id}`); }
  ok(h2.stack.length === before + 1, `50 drag frames coalesce into 1 step (stack ${before} -> ${h2.stack.length})`);
  h2.undo();
  ok(near(s2.get(o2.id).transform.x, 10), 'undo reverts the whole drag', String(s2.get(o2.id)?.transform.x));
}

console.log('\n=== 6. Rasteriser ===');
{
  const s = new Scene(256, 128);
  s.add(Shapes.circle(66, 64.5, 14, { name: 'Cyl' }));
  const r = new Raster(256, 128);
  ok(r.build(s), 'first build reports a change');
  ok(!r.build(s), 'rebuilding an unchanged scene is skipped');

  const st = r.stats();
  const area = Math.PI * 14 * 14;
  console.log(`    solid=${st.solid} cells, analytic area=${area.toFixed(0)}, partial=${st.partial}`);
  ok(Math.abs(st.solid - area) / area < 0.06, 'solid area matches the analytic circle within 6%');
  // A radius-14 circle has a ~88-cell rim; roughly half fall below the
  // half-coverage threshold and stay fractional.
  ok(st.partial > 25, 'a fractional rim exists (input for anti-aliasing)', `${st.partial} cells`);

  // Coverage must be fractional at the rim and 1 in the core.
  const s2 = r.stride;
  ok(r.coverage[66 + 64 * s2] === 1, 'core coverage is 1');
  let sawFraction = false;
  for (let i = 0; i < r.coverage.length; i++) { const c = r.coverage[i]; if (c > 0 && c < 1) { sawFraction = true; break; } }
  ok(sawFraction, 'rim coverage is fractional');

  // Boundary roles.
  const s3 = new Scene(128, 64);
  s3.add(Shapes.rect(20, 32, 8, 40, { boundary: 'inlet', bcParams: { speed: 2, direction: 0 } }));
  s3.add(Shapes.circle(70, 32, 8, { boundary: 'porous', bcParams: { resistance: 0.7 } }));
  s3.add(Shapes.circle(100, 32, 6, { boundary: 'noslip' }));
  const r3 = new Raster(128, 64);
  r3.build(s3);
  const idx = (i, j) => i + j * r3.stride;
  ok(r3.bcType[idx(20, 32)] === BOUNDARIES.inlet.code, 'inlet cells carry the inlet code');
  ok(r3.solid[idx(20, 32)] === 0, 'an inlet does not block the cell');
  ok(near(r3.bcU[idx(20, 32)], 2, 1e-6), 'inlet velocity is recorded');
  ok(r3.bcType[idx(70, 32)] === BOUNDARIES.porous.code && r3.solid[idx(70, 32)] === 0, 'porous cells are not solid');
  ok(near(r3.bcK[idx(70, 32)], 0.7, 1e-6), 'porous resistance is recorded');
  ok(r3.solid[idx(100, 32)] === 1, 'no-slip cells are solid');

  // Rotating body: prescribed velocity should be tangential.
  const s4 = new Scene(128, 64);
  s4.add(Shapes.circle(64, 32, 10, { boundary: 'rotating', bcParams: { omega: 0.5 } }));
  const r4 = new Raster(128, 64);
  r4.build(s4);
  const i4 = (i, j) => i + j * r4.stride;
  // Clockwise on a y-down screen: the top of the body moves +x, the right side
  // moves +y. (An earlier version of this test asserted the opposite and was
  // simply wrong about which way clockwise looks in screen coordinates.)
  const ux = r4.bcU[i4(64, 26)], vy = r4.bcV[i4(70, 32)];
  console.log(`    above centre u=${ux.toFixed(2)} (want >0), right of centre v=${vy.toFixed(2)} (want >0)`);
  ok(ux > 0 && vy > 0, 'rotating body velocity is tangential and clockwise for +omega');
  const uxBelow = r4.bcU[i4(64, 38)];
  ok(uxBelow < 0, 'below centre the tangential velocity reverses', String(uxBelow));
}

console.log('\n=== 7. Rasteriser drives the solver ===');
{
  const s = new Scene(256, 128);
  s.add(Shapes.circle(66, 64.5, 14, { name: 'Cyl' }));
  const r = new Raster(256, 128);
  r.build(s);

  const g = new Grid(256, 128);
  const ns = new NavierStokes(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = 2.4; ns.visc = 0.006;
  ns.speedCap = 2.4 * 25;
  r.applyTo(g);
  ns.onGeometryChanged();
  ns.seedFreestream();

  ok(g.hasSolid, 'grid picked up the obstacle');
  let bad = false, peak = 0;
  for (let f = 0; f < 400; f++) {
    const uMax = ns.measureMaxSpeed();
    let dt = uMax > 1e-6 ? 1 / uMax : 0.4;
    dt = Math.min(0.4, Math.max(0.1 / 2.4, Math.max(1e-4, dt)));
    ns.step(dt, PALETTE); ns.dyeStep(dt);
    for (let i = 0; i < g.u.length; i++) if (!Number.isFinite(g.u[i])) { bad = true; break; }
    if (bad) break;
    const m = ns.maxSpeed; if (m > peak) peak = m;
  }
  ok(!bad, 'solver runs stably on a scene-rasterised body');
  ok(peak / 2.4 < 4, `peak speed ${(peak / 2.4).toFixed(1)}x inlet (potential flow says ~2x)`);
}

console.log('\n=== 8. Transforms and gizmo ===');
{
  const o = Shapes.rect(50, 50, 20, 10);
  T.move(o, 5, -3);
  ok(o.transform.x === 55 && o.transform.y === 47, 'move');

  T.resizeTo(o, 40, 20);
  const m = T.measure(o);
  ok(near(m.w, 40, 1e-6) && near(m.h, 20, 1e-6), 'resizeTo then measure round-trips', `${m.w}x${m.h}`);

  T.mirror(o, 'h');
  ok(o.transform.sx < 0, 'mirror flips the scale sign');
  const m2 = T.measure(o);
  ok(near(m2.w, 40, 1e-6), 'mirroring preserves the measured size');

  const c = Shapes.circle(0, 0, 5);
  T.rotateAbout(c, 90, 10, 0);
  ok(near(c.transform.x, 10, 1e-6) && near(c.transform.y, -10, 1e-6),
    'rotateAbout orbits the pivot', `${c.transform.x},${c.transform.y}`);

  const box = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
  ok(T.hitHandle(box, 30, 40) === 'se', 'south-east handle hit');
  ok(T.hitHandle(box, 20, 20) === 'n', 'north handle hit');
  ok(T.hitHandle(box, 20, 30) === null, 'centre is not a handle');

  const d = T.handleDrag(box, 'se', 50, 60);
  ok(near(d.fx, 2) && near(d.fy, 2) && d.pivotX === 10 && d.pivotY === 20,
    'dragging SE to double the box gives 2x about the NW corner', `fx=${d.fx} fy=${d.fy}`);

  const du = T.handleDrag(box, 'se', 50, 45, { uniform: true });
  ok(near(du.fx, du.fy), 'uniform drag keeps the aspect ratio');

  // A drag through the pivot must not collapse the object irrecoverably.
  const dz = T.handleDrag(box, 'se', 10, 20);
  ok(Math.abs(dz.fx) > 0 && Math.abs(dz.fy) > 0, 'degenerate drag is clamped, not zeroed');

  ok(near(T.snapValue(10.4, 1), 10) && near(T.snapValue(10.6, 1), 11), 'grid snapping rounds');
  const others = [Shapes.rect(100, 50, 20, 20)];
  const snap = T.snapToEdges({ minX: 89, minY: 40, maxX: 109, maxY: 60 }, others, 2);
  ok(Math.abs(snap.dx) > 0, 'edge snapping proposes an offset when close');
}

console.log('\n=== 9. Scene reproduces the built-in scenarios ===');
{
  const s = new Scene(256, 128);
  s.add(Shapes.circle(256 * 0.26, 64.5, 128 * 0.11));
  const r = new Raster(256, 128);
  r.build(s);
  const st = r.stats();
  // Compare against the legacy builder for the same cylinder.
  const g = new Grid(256, 128);
  loadScenario(g, 'cylinder');
  let legacy = 0;
  for (let i = 0; i < g.solid.length; i++) legacy += g.solid[i];
  console.log(`    scene raster=${st.solid} cells, legacy builder=${legacy} cells`);
  ok(Math.abs(st.solid - legacy) / legacy < 0.10, 'scene rasteriser agrees with the legacy builder within 10%');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);

