/* Validation against published values. */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { Diagnostics } = await import(B + 'diagnostics.js');
const { Scene, Shapes } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');
const { PALETTE } = await import(B + 'colormaps.js');

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const rms = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

/* Settle and sample are measured in SIMULATION TIME, not steps.
 *
 * They used to be fixed step counts, which quietly invalidated the grid
 * convergence study below: a finer mesh is also a LONGER tunnel, so the same
 * 500 steps bought steadily less physical development. At 384x192 that was
 * 0.70 tunnel flow-throughs — the vortex street had barely started — and the
 * measured drag fell with refinement purely because the wake was younger, not
 * because the discretisation was worse.
 *
 * Measured convergence at D=24, Re=200:
 *     0.70 flow-throughs   Cd 0.917   Cl rms 0.113   St 0.159
 *     2.59 flow-throughs   Cd 1.057   Cl rms 0.371   St 0.198
 *     5.16 flow-throughs   Cd 1.057   Cl rms 0.375   St 0.197
 * so 2.5 is settled and anything below ~1.5 is measuring a transient. */
const SETTLE_FLOWS = 2.5;      // tunnel lengths swept by the freestream
const SAMPLE_CYCLES = 12;      // shedding periods, at the expected St ~ 0.2

function cylinder({ nx = 384, ny = 192, D, U, Re, settleFlows = SETTLE_FLOWS, sampleCycles = SAMPLE_CYCLES }) {
  const visc = U * D / Re;
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  const d = new Diagnostics(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = U; ns.visc = visc;
  ns.speedCap = U * 25; ns.vorticity = 0; ns.les = false;
  /* Defaults to the STAGGERED solver, because that is what the app defaults to.
   *
   * It was briefly the other way round, which is the same mistake this project
   * has now made twice: validating a configuration nobody runs. Set
   * COLLOCATED=1 to measure the old path for comparison — that is the whole
   * point of keeping it, and the two are wrong in opposite directions (see
   * CONTEXT.md section 3). */
  ns.mac = process.env.COLLOCATED !== '1';
  const scene = new Scene(nx, ny);
  scene.add(Shapes.circle(nx * 0.25, (ny + 1) / 2, D / 2));
  const r = new Raster(nx, ny); r.build(scene); r.applyTo(g, U);
  ns.onGeometryChanged(); ns.seedFreestream();

  const step = () => {
    const uMax = ns.measureMaxSpeed();
    let dt = uMax > 1e-6 ? 1 / uMax : 0.4;
    dt = Math.min(0.4, Math.max(1e-4, dt));
    ns.step(dt, PALETTE);
    d.forces(U, visc, dt);
    d.integrals(dt, visc, 0, 1);
    d.trackShedding(dt, U);
    return dt;
  };
  const tSettle = settleFlows * (nx / U);
  const tSample = sampleCycles * (D / (0.2 * U));
  let t = 0, steps = 0;
  while (t < tSettle) { t += step(); steps++; }
  d.resetShedding();
  const cl = [], cd = [];
  for (let t0 = t; t - t0 < tSample;) { t += step(); steps++; cl.push(d.cl); cd.push(d.cd); }
  return { cd: mean(cd), clRms: rms(cl), clMean: mean(cl), st: d.strouhal, visc, regime: d.regime,
           steps, flows: tSettle / (nx / U) };
}

console.log('=== Circular cylinder: drag and Strouhal vs Reynolds ===');
console.log(`  solver: ${process.env.COLLOCATED === '1' ? 'collocated (COLLOCATED=1)' : 'STAGGERED (MAC) — the app default'}`);
console.log('  D = 24 cells, U = 2.0 cells/t, 384x192\n');
console.log('   Re     Cd      Cl rms    St       reference Cd / St');
const REF = {
  60:  ['1.35 - 1.45', '0.13 - 0.14'],
  100: ['1.30 - 1.40', '0.16 - 0.17'],
  200: ['1.28 - 1.40', '0.19 - 0.20'],
  400: ['1.25 - 1.40', '0.20 - 0.21'],
};
for (const Re of [60, 100, 200, 400]) {
  const r = cylinder({ D: 24, U: 2.0, Re });
  const ref = REF[Re];
  console.log(`  ${String(Re).padStart(4)}   ${r.cd.toFixed(3)}   ${r.clRms.toFixed(3)}   ${(r.st || 0).toFixed(3)}    Cd ${ref[0]}, St ${ref[1]}`);
}

console.log('\n=== Steady regime: no shedding below Re ~47 ===');
for (const Re of [20, 40]) {
  const r = cylinder({ D: 24, U: 2.0, Re, sampleCycles: 6 });
  console.log(`  Re ${String(Re).padStart(3)}  Cd=${r.cd.toFixed(3)}  Cl rms=${r.clRms.toFixed(4)}  ${r.clRms < 0.05 ? 'steady (correct)' : 'SHEDDING (should be steady)'}`);
}

console.log('\n=== Grid convergence: same physics, finer mesh, EQUAL PHYSICAL TIME ===');
console.log(`  each case settles ${SETTLE_FLOWS} tunnel flow-throughs and samples ${SAMPLE_CYCLES} shedding periods\n`);
for (const [nx, ny, D] of [[256, 128, 16], [384, 192, 24], [512, 256, 32]]) {
  const r = cylinder({ nx, ny, D, U: 2.0, Re: 200 });
  console.log(`  ${String(nx + 'x' + ny).padEnd(9)} D=${String(D).padStart(2)} cells   Cd=${r.cd.toFixed(3)}   Cl rms=${r.clRms.toFixed(3)}   St=${(r.st || 0).toFixed(3)}   (${r.steps} steps)`);
}
console.log('  (Cd should settle as the body is better resolved)');
