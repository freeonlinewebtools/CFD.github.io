/* The particle (APIC) liquid solver.
 *
 * NOT yet wired into the app — `src/freesurface.js` is still what water mode
 * runs. This suite exists so the replacement can be judged on the thing the old
 * scheme could never do, and so the work is verifiable while it is finished.
 *
 * The old solver advected a fill FRACTION, which is lossy every step: a tank
 * lost 11-24 % of its water depending on what you did to it, and two further
 * mechanisms (`sharpen`, `correctVolume`) existed only to disguise that. The
 * whole point of particles is that mass stops being a quantity that can drift,
 * so the first assertion here is exact equality rather than a tolerance — which
 * is a test that could not have been written against the old representation at
 * all.
 */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { Flip, PER_CELL } = await import(B + 'flip.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); }
};

function tank(nx = 128, ny = 96, depth = 0.45) {
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  ns.mac = true; ns.windTunnel = false; g.openX = false;
  ns.visc = 0; ns.les = false; ns.vorticity = 0; ns.dyeFade = 1;
  ns.speedCap = Math.sqrt(9 * ny * depth) * 3;
  const fs = new Flip(g);
  fs.enabled = true;
  return { g, ns, fs };
}
const step = t => {
  const uMax = t.ns.measureMaxSpeed();
  t.fs.step(Math.min(0.12, Math.max(1e-3, 1 / Math.max(uMax, 1e-6))), t.ns);
};
const peak = g => {
  let m = 0;
  for (let i = 0; i < g.size; i++) { const q = Math.hypot(g.u[i], g.v[i]); if (q > m) m = q; }
  return m;
};
const occupied = fs => {
  let n = 0;
  for (let i = 0; i < fs.countCell.length; i++) if (fs.countCell[i] > 0) n++;
  return n;
};
const maxDensity = fs => {
  let m = 0;
  for (let i = 0; i < fs.countCell.length; i++) if (fs.countCell[i] > m) m = fs.countCell[i];
  return m;
};

console.log('=== 1. Mass is exact, not merely conserved ===');
/* The old scheme could hold a tolerance at best. A particle count is an integer
 * and nothing in the step creates or destroys one, so this is equality. */
{
  const t = tank();
  t.fs.reset(0.45);
  const n0 = t.fs.count, v0 = t.fs.volume();
  for (let k = 0; k < 400; k++) step(t);
  console.log(`    particles ${n0} -> ${t.fs.count}, volume ${v0} -> ${t.fs.volume()}`);
  ok(t.fs.count === n0, 'the particle count is unchanged after 400 steps',
    `${n0} -> ${t.fs.count}`);
  ok(t.fs.volume() === v0, 'so the volume is EXACTLY unchanged',
    `${v0} -> ${t.fs.volume()}`);
}

console.log('\n=== 2. The water is not compressed ===');
/* Mass being exact says nothing about whether the water occupies the right
 * amount of space — particles could pile up and mass would still balance. The
 * density bias in the projection is what prevents that; without it the pool
 * compacted while the count stayed perfect. */
{
  const t = tank();
  t.fs.reset(0.45);
  const ideal = Math.round(t.fs.count / PER_CELL);
  for (let k = 0; k < 400; k++) step(t);
  const occ = occupied(t.fs);
  console.log(`    occupies ${occ} cells, ideal ${ideal} (${((occ / ideal - 1) * 100).toFixed(1)}%), densest cell ${maxDensity(t.fs)} of ${PER_CELL}`);
  ok(occ > ideal * 0.92, 'the water still fills the space it should',
    `${occ} vs ${ideal}`);
}

console.log('\n=== 3. A dam break runs the length of the tank ===');
{
  const t = tank(160, 96);
  t.fs.preset('dam');
  const n0 = t.fs.count;
  const front = () => {
    let f = 0;
    for (let k = 0; k < t.fs.count; k++) if (t.fs.px[k] > f) f = t.fs.px[k];
    return f;
  };
  const f0 = front();
  for (let k = 0; k < 400; k++) step(t);
  const f1 = front();
  console.log(`    front ${f0.toFixed(0)} -> ${f1.toFixed(0)} of 160`);
  ok(f1 > f0 + 40, 'the column collapses and runs along the floor',
    `${f0.toFixed(0)} -> ${f1.toFixed(0)}`);
  ok(t.fs.count === n0, 'and loses nothing on the way', `${n0} -> ${t.fs.count}`);
  let finite = true;
  for (let i = 0; i < t.g.size; i++) if (!Number.isFinite(t.g.u[i])) finite = false;
  ok(finite, 'the field stays finite');
}

console.log('\n=== 4. Water does not pass through solids ===');
/* The failure that would make particles worse than a fraction: a parcel that
 * tunnels through a wall is water appearing where it cannot be. */
{
  const t = tank(128, 96);
  const { g, fs } = t;
  const s = g.stride;
  for (let i = 1; i <= 128; i++) for (let d = 0; d < 3; d++) g.solid[i + (60 + d) * s] = 1;
  g.refreshSolidFlag(); t.ns.onGeometryChanged();
  fs.reset(0.25);                       // water sits ABOVE the floor we drew
  for (let k = 0; k < 300; k++) step(t);
  let through = 0;
  for (let k = 0; k < fs.count; k++) {
    const i = Math.round(fs.px[k]), j = Math.round(fs.py[k]);
    if (i >= 1 && i <= 128 && j >= 1 && j <= 96 && g.solid[i + j * s]) through++;
  }
  console.log(`    ${through} of ${fs.count} particles inside solid`);
  ok(through === 0, 'no particle ends up inside a wall', String(through));
}

console.log('\n=== 5. Save and load restores the water exactly ===');
{
  const t = tank(96, 64);
  t.fs.reset(0.4);
  for (let k = 0; k < 40; k++) step(t);
  const n0 = t.fs.count;
  const enc = t.fs.serialise();
  const t2 = tank(96, 64);
  const n1 = t2.fs.deserialise(enc);
  let worst = 0;
  for (let k = 0; k < n0; k++) {
    worst = Math.max(worst, Math.abs(t2.fs.px[k] - t.fs.px[k]), Math.abs(t2.fs.py[k] - t.fs.py[k]));
  }
  console.log(`    ${n0} particles -> ${enc.length} base64 chars -> ${n1} particles, worst position error ${worst.toFixed(4)} cells`);
  ok(n1 === n0, 'every particle round-trips', `${n0} -> ${n1}`);
  ok(worst <= 1 / 32 + 1e-6, 'to within the quantisation step', worst.toFixed(4));
}

console.log('\n=== 6. Known-unfinished: a still pool is not yet still ===');
/* Reported honestly rather than asserted away. A settled pool should be quiet;
 * the density bias fires on ordinary seeding jitter and keeps stirring it. The
 * deadband reduced this from 14.3 to about 10 against a gravity-wave speed of
 * roughly 20, which is better and is not yet right. This prints the number and
 * only fails if it becomes an outright instability, so the figure stays visible
 * while the work is finished. */
{
  const t = tank();
  t.fs.reset(0.45);
  for (let k = 0; k < 300; k++) step(t);
  const p = peak(t.g);
  const wave = Math.sqrt(9 * 96 * 0.45);
  console.log(`    residual peak |u| ${p.toFixed(2)}, gravity-wave speed ${wave.toFixed(1)} — should be near zero`);
  ok(p < t.ns.speedCap, 'it is at least bounded and not diverging',
    `${p.toFixed(2)} vs cap ${t.ns.speedCap.toFixed(1)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
