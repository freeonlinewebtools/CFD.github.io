/* Porous regions must slow flow without blocking it. */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { Diagnostics } = await import(B + 'diagnostics.js');
const { Scene, Shapes } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');
const { PALETTE } = await import(B + 'colormaps.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); } };

function run(role, resistance) {
  const nx = 256, ny = 128;
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  const d = new Diagnostics(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = 2.4; ns.visc = 0.02;
  ns.speedCap = 2.4 * 25;
  const scene = new Scene(nx, ny);
  scene.add(Shapes.rect(nx * 0.3, (ny + 1) / 2, 12, ny * 0.5,
    { boundary: role, bcParams: { resistance } }));
  const r = new Raster(nx, ny);
  r.build(scene);
  r.applyTo(g, 2.4);
  ns.onGeometryChanged(); ns.seedFreestream();

  for (let f = 0; f < 400; f++) {
    const uMax = ns.measureMaxSpeed();
    let dt = uMax > 1e-6 ? 1 / uMax : 0.4;
    dt = Math.min(0.4, Math.max(1e-4, dt));
    ns.step(dt, PALETTE); ns.dyeStep(dt);
    d.forces(2.4, ns.visc, dt);
  }
  // Mean speed through the middle of the obstacle band.
  const s = g.stride;
  let inside = 0, n = 0, bad = false;
  for (let j = Math.round(ny * 0.3); j <= Math.round(ny * 0.7); j++) {
    const idx = Math.round(nx * 0.3) + j * s;
    if (!Number.isFinite(g.u[idx])) bad = true;
    if (!g.solid[idx]) { inside += g.u[idx]; n++; }
  }
  let solidCells = 0;
  for (let i = 0; i < g.solid.length; i++) solidCells += g.solid[i];
  return { through: n ? inside / n : 0, openCells: n, solidCells, bad, hasPorous: g.hasPorous };
}

console.log('=== Porous vs solid, same rectangle ===');
const solid = run('noslip', 0);
console.log(`  no-slip    solid cells=${solid.solidCells}  open cells in band=${solid.openCells}  u through=${solid.through.toFixed(3)}`);
ok(solid.solidCells > 300, 'a no-slip rectangle blocks its cells');

const results = [];
for (const k of [0.2, 0.5, 0.9]) {
  const p = run('porous', k);
  results.push(p);
  console.log(`  porous ${k.toFixed(1)}  solid cells=${p.solidCells}  open cells in band=${p.openCells}  u through=${p.through.toFixed(3)}  hasPorous=${p.hasPorous}`);
  ok(!p.bad, `resistance ${k}: field stays finite`);
  ok(p.solidCells === 0, `resistance ${k}: porous cells are NOT solid`);
  ok(p.hasPorous, `resistance ${k}: grid flags the porous region`);
}

ok(results[0].through > 0.05, 'low resistance still lets flow through', `u=${results[0].through.toFixed(3)}`);
ok(results[2].through < results[0].through, 'higher resistance slows the flow more',
  `${results[0].through.toFixed(3)} -> ${results[2].through.toFixed(3)}`);
ok(results[2].through > -0.2, 'high resistance does not reverse the flow', `u=${results[2].through.toFixed(3)}`);
ok(results[2].through < solid.through + 1.0, 'high resistance approaches the blocked case');

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
