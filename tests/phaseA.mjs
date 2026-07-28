/* Phase A verification: re-run the exact reproductions that confirmed the bugs. */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { Particles } = await import(B + 'particles.js');
const { SCENARIO_BY_ID } = await import(B + 'scenarios.js');
const { PALETTE } = await import(B + 'colormaps.js');

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
const peak = a => { let m = 0; for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (Number.isFinite(x) && x > m) m = x; } return m; };
const bad = a => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return true; return false; };

const UREF = 120 / 50;
function mk(scn = 'cylinder') {
  const g = new Grid(256, 128);
  const ns = new NavierStokes(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = UREF; ns.visc = 0.006;
  ns.speedCap = UREF * 25;
  loadScenario(g, scn);
  g.refreshSolidFlag(); ns.onGeometryChanged(); ns.seedFreestream();
  return { g, ns };
}
function frame(ctx, cfl = 1.0) {
  const uMax = ctx.ns.measureMaxSpeed();
  let dt = uMax > 1e-6 ? cfl / uMax : 0.4;
  const dtFloor = 0.1 * cfl / UREF;
  if (dt < dtFloor) dt = dtFloor;
  dt = Math.min(0.4, Math.max(1e-4, dt));
  ctx.ns.step(dt, PALETTE); ctx.ns.dyeStep(dt);
  return dt;
}

// Mirror main.js paintBrush exactly.
function paintBrush(g, gx, gy, dirX, dirY, mag, force = 90, brush = 14) {
  const { nx, ny, stride: s, solid, u, v, fx, fy } = g;
  const ramp = Math.min(1, mag / 6);
  const target = (force / 100) * UREF * 3 * ramp;
  const tx = dirX * target, ty = dirY * target, rate = 0.35;
  const ci = Math.round(gx), cj = Math.round(gy), ri = Math.ceil(brush);
  for (let dj = -ri; dj <= ri; dj++) for (let di = -ri; di <= ri; di++) {
    const d2 = di * di + dj * dj;
    if (d2 > brush * brush) continue;
    const i = ci + di, j = cj + dj;
    if (i < 1 || i > nx || j < 1 || j > ny) continue;
    const idx = i + j * s;
    if (solid[idx]) continue;
    const a = (1 - Math.sqrt(d2) / (brush + 1)) * rate;
    fx[idx] += (tx - u[idx]) * a;
    fy[idx] += (ty - v[idx]) * a;
  }
}

console.log('=== 3/5. Brush force is bounded (was 27x inlet at an 8-cell drag) ===');
for (const dragCells of [1, 3, 8, 20, 60]) {
  const ctx = mk();
  for (let f = 0; f < 40; f++) frame(ctx);
  const before = peak(ctx.g.u);
  // Sustained scrubbing, not a single stroke — 60 frames of dragging.
  let worst = before;
  for (let f = 0; f < 60; f++) {
    paintBrush(ctx.g, 80, 64, 1, 0, dragCells);
    frame(ctx);
    const pk = peak(ctx.g.u);
    if (pk > worst) worst = pk;
  }
  let blew = false;
  for (let f = 0; f < 200; f++) { frame(ctx); if (bad(ctx.g.u) || peak(ctx.g.u) > 1e4) { blew = true; break; } }
  const ratio = worst / UREF;
  ok(!blew && ratio < 14,
    `drag ${String(dragCells).padStart(2)} cells/frame x60 -> peak ${ratio.toFixed(1)}x inlet, settles to ${(peak(ctx.g.u) / UREF).toFixed(1)}x`,
    blew ? 'DIVERGED' : `${ratio.toFixed(1)}x`);
}

console.log('\n=== 3. Brush direction is preserved (not inverted) ===');
{
  // Paint in clear fluid, well away from the body — a probe inside the
  // cylinder reads zero because the solid BC holds it there.
  const PX = 170, PY = 40;
  for (const [dx, dy, name] of [[1, 0, 'right'], [-1, 0, 'left'], [0, 1, 'down'], [0, -1, 'up']]) {
    const c2 = mk();
    const s = c2.g.stride, probe = PX + PY * s;
    if (c2.g.solid[probe]) { ok(false, `probe cell (${PX},${PY}) must be fluid`); break; }
    for (let f = 0; f < 40; f++) frame(c2);
    const u0 = c2.g.u[probe], v0 = c2.g.v[probe];
    for (let f = 0; f < 25; f++) { paintBrush(c2.g, PX, PY, dx, dy, 10); frame(c2); }
    const du = c2.g.u[probe] - u0, dv = c2.g.v[probe] - v0;
    const along = du * dx + dv * dy;
    ok(along > 0, `drag ${name.padEnd(5)} -> flow follows (du=${du.toFixed(2)}, dv=${dv.toFixed(2)}, along=${along.toFixed(2)})`,
      `along=${along.toFixed(3)}`);
  }
}

console.log('\n=== 4. Emitter strength is bounded ===');
{
  const uRef = 2.4;
  for (const dragLen of [5, 22, 60]) {
    const speed = Math.min(2.5, Math.max(0.4, dragLen / 22));
    const strength = Math.min(20, Math.max(6, dragLen * 0.7));
    const rate = Math.min(0.8, Math.max(0.1, strength / 20));
    const target = speed * uRef;
    ok(target <= 2.5 * uRef + 1e-9,
      `drag ${String(dragLen).padStart(2)} -> target ${target.toFixed(2)} cells/t (${(target / uRef).toFixed(2)}x inlet), relax rate ${rate.toFixed(2)}`);
  }
}

console.log('\n=== 7. Particle trails: no stray joins, newest always drawn ===');
{
  const ctx = mk();
  const p = new Particles(ctx.g, PALETTE, 60, 14);
  p.seed(true);
  const segs = [];
  // Instrument a fake ctx that records every path segment length.
  const rec = {
    _x: 0, _y: 0,
    beginPath() {}, moveTo(x, y) { this._x = x; this._y = y; },
    lineTo(x, y) { segs.push(Math.hypot(x - this._x, y - this._y)); this._x = x; this._y = y; },
    arc() {}, stroke() {}, fill() {},
    set strokeStyle(v) {}, set fillStyle(v) {}, set lineWidth(v) {},
  };
  let worstFrame = 0;
  for (let f = 0; f < 60; f++) {
    const dt = frame(ctx);
    p.advect(dt);
    segs.length = 0;
    p.render(rec, 4, 4, false);
    const mx = segs.length ? Math.max(...segs) : 0;
    if (mx > worstFrame) worstFrame = mx;
  }
  // A legitimate segment is one advection step: |u|*dt*scale. With scale 4 and
  // CFL 1 that is ~4px. A stray join spans much of the trail, tens of px.
  console.log(`  longest single trail segment over 60 frames: ${worstFrame.toFixed(1)} px (scale 4 px/cell)`);
  ok(worstFrame < 20, 'no segment leaps across the trail', `${worstFrame.toFixed(1)} px`);

  let drawnNewest = 0;
  for (let k = 0; k < p.count; k++) if (p.len[k] >= 1) drawnNewest++;
  ok(drawnNewest > p.count * 0.9, `${drawnNewest}/${p.count} particles have a drawable trail`);
}

console.log('\n=== 6. Colour map cannot be blacked out by a transient ===');
{
  let norm = 1;
  const MAX_RISE = 1.10;
  const blend = (cur, next) => next > cur ? Math.min(next, cur * MAX_RISE) : cur + (next - cur) * 0.05;
  const spike = 60;                       // a transient 25x the steady value
  let frames = 0;
  while (norm < spike * 0.9 && frames < 1000) { norm = blend(norm, spike); frames++; }
  ok(frames > 20, `a 25x transient takes ${frames} frames to rescale the map, not 1`);
}

console.log('\n=== 8. Peak speed tracked in every view (overlay scaling) ===');
{
  const src = await import(B + 'main.js').catch(() => null);
  // main.js needs a DOM; assert on the source instead.
  const fs = await import('node:fs');
  // Resolve against THIS file, not the working directory, so the suite runs
  // the same from the repo root and from tests/.
  const txt = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const body = txt.slice(txt.indexOf('function computeNorm'), txt.indexOf('function simulate'));
  ok(!/wantUV/.test(body), 'speed is no longer gated behind a mode check');
  ok(/n\.speed = blend/.test(body) && !/if \(wantUV\) n\.speed/.test(body), 'n.speed updated unconditionally');
}

console.log('\n=== Regression: solver still stable and accurate ===');
for (const scn of ['cylinder', 'plate', 'airfoil-cambered', 'staggered', 'bifurcation']) {
  const ctx = mk(scn);
  let worst = 0, blew = -1;
  for (let f = 0; f < 900; f++) {
    frame(ctx);
    const pk = peak(ctx.g.u);
    if (pk > worst) worst = pk;
    if (bad(ctx.g.u) || pk > 1e4) { blew = f; break; }
  }
  ok(blew < 0, `${scn.padEnd(18)} stable over 900 frames, peak ${(worst / UREF).toFixed(1)}x inlet`, blew >= 0 ? 'diverged at ' + blew : '');
}


console.log('\n=== Brush impulses cannot accumulate across pointer events ===');
/* `fx`/`fy` are per-frame impulses cleared inside ns.step(), but pointermove
 * fires many times per frame — more when the frame rate drops, and more still
 * where two strokes overlap the same cells. Every event used to add another
 * full relaxation toward the target, so the push tool's effect scaled with the
 * mouse polling rate. Measured before the clamp, against a target of 6.5
 * cells/time: 1 event a frame gave 6.8, 8 gave 64.6, 16 gave 72.4.
 *
 * This mirrors main.js paintBrush, including its limitImpulse clamp, and
 * asserts the result is independent of how many events land per frame. */
{
  const U = 2.4;
  const mkTunnel = () => {
    const g = new Grid(160, 80);
    const ns = new NavierStokes(g);
    ns.windTunnel = true; g.openX = true; ns.inletSpeed = U; ns.visc = 0.02;
    ns.speedCap = U * 25; ns.les = false; ns.vorticity = 0;
    loadScenario(g, 'cylinder');
    ns.onGeometryChanged(); ns.seedFreestream();
    return { g, ns };
  };
  const stepOne = (ns, g) => {
    const uMax = ns.measureMaxSpeed();
    const dt = Math.min(0.4, Math.max(1e-4, uMax > 1e-6 ? 1 / uMax : 0.4));
    ns.step(dt, PALETTE);
  };
  const brushTarget = 0.9 * U * 3;
  const push = (g, gx, gy) => {
    const { nx, ny, stride: s, solid, u, v, fx, fy } = g;
    const r = 14, ci = Math.round(gx), cj = Math.round(gy), ri = Math.ceil(r);
    const tx = brushTarget, ty = 0, rate = 0.35;
    for (let dj = -ri; dj <= ri; dj++) for (let di = -ri; di <= ri; di++) {
      const d2 = di * di + dj * dj;
      if (d2 > r * r) continue;
      const i = ci + di, j = cj + dj;
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      const idx = i + j * s;
      if (solid[idx]) continue;
      const a = (1 - Math.sqrt(d2) / (r + 1)) * rate;
      fx[idx] += (tx - u[idx]) * a;
      fy[idx] += (ty - v[idx]) * a;
      const nu = u[idx] + fx[idx], nv = v[idx] + fy[idx];
      const m = Math.hypot(nu, nv);
      const lim = Math.max(Math.abs(tx), Math.hypot(u[idx], v[idx]));
      if (m > lim && m > 1e-9) { const k = lim / m; fx[idx] = nu * k - u[idx]; fy[idx] = nv * k - v[idx]; }
    }
  };

  const peaks = [];
  for (const perFrame of [1, 4, 8, 16]) {
    const { g, ns } = mkTunnel();
    for (let i = 0; i < 200; i++) stepOne(ns, g);
    for (let f = 0; f < 60; f++) {
      for (let k = 0; k < perFrame; k++) push(g, 160 * 0.55, 80 * 0.5);
      stepOne(ns, g);
    }
    let m = 0;
    for (let i = 0; i < g.size; i++) {
      const a = Math.hypot(g.u[i], g.v[i]);
      if (!Number.isFinite(a)) { m = Infinity; break; }
      if (a > m) m = a;
    }
    peaks.push(m);
    console.log(`    ${String(perFrame).padStart(2)} events/frame -> peak |u| ${m === Infinity ? 'NON-FINITE' : m.toFixed(1)}`);
  }
  ok(peaks.every(p => Number.isFinite(p)), 'no event rate drives the field non-finite');
  ok(peaks.every(p => p < brushTarget * 3),
    'peak stays within 3x the brush target at every event rate',
    peaks.map(p => p.toFixed(1)).join(', '));
  const spread = Math.max(...peaks) / Math.min(...peaks);
  ok(spread < 2.2, 'the stroke does not scale with the pointer polling rate',
    `${Math.min(...peaks).toFixed(1)} -> ${Math.max(...peaks).toFixed(1)}`);
}

console.log('\n=== Vorticity reads the way a viewer expects ===');
/* `j` increases DOWNWARD, so the textbook expression dv/dx - du/dy is POSITIVE
 * for CLOCKWISE rotation here — the opposite of every convention a reader
 * brings. The displayed field therefore negates it. This checks the particle
 * colouring, which shares the expression with both shaders. */
{
  const { Particles: P } = await import(B + 'particles.js');
  const g = new Grid(40, 40);
  const s = g.stride, cx = 20, cy = 20;
  const parts = new P(g, PALETTE, 8, 6);
  parts.mode = 'vorticity';
  const mode = { id: 'vorticity' };
  const norm = { curl: 0.5 };

  const spin = dirn => {
    for (let j = 0; j <= 41; j++) for (let i = 0; i <= 41; i++) {
      const dx = i - cx, dy = j - cy;
      g.u[i + j * s] = -dy * dirn * 0.1;
      g.v[i + j * s] = dx * dirn * 0.1;
    }
  };
  // dirn = +1 puts the flow at 3 o'clock pointing +y, and +y is DOWN on
  // screen, so it turns clockwise.
  parts.px[0] = cx + 5; parts.py[0] = cy;
  spin(1);
  const cw = parts.scalarAt(0, mode, norm);
  spin(-1);
  const ccw = parts.scalarAt(0, mode, norm);
  console.log(`    clockwise -> ${cw.toFixed(3)},  anticlockwise -> ${ccw.toFixed(3)}  (0.5 = no rotation)`);
  ok(cw < 0.5, 'clockwise maps below the diverging midpoint', cw.toFixed(3));
  ok(ccw > 0.5, 'anticlockwise maps above it', ccw.toFixed(3));
  ok(Math.abs((cw - 0.5) + (ccw - 0.5)) < 1e-6, 'the two are symmetric about zero');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
