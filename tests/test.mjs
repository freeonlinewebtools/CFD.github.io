/* Regression + physics tests for the rebuilt solver. */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { LatticeBoltzmann } = await import(B + 'lbm.js');
const { Diagnostics } = await import(B + 'diagnostics.js');
const { Particles } = await import(B + 'particles.js');
const { SCENARIOS, SCENARIO_BY_ID } = await import(B + 'scenarios.js');
const { FreeSurface } = await import(B + 'freesurface.js');
const { PALETTE } = await import(B + 'colormaps.js');
const T = await import(B + 'transform.js');

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
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? '  <- ' + detail : ''}`); }
};
const stats = a => {
  let nan = 0, inf = 0, m = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (Number.isNaN(x)) nan++;
    else if (!Number.isFinite(x)) inf++;
    else if (Math.abs(x) > m) m = Math.abs(x);
  }
  return { nan, inf, max: m };
};
const clean = (a, name) => {
  const s = stats(a);
  return { ok: s.nan === 0 && s.inf === 0, s, name };
};

function makeNS(nx = 256, ny = 128, wind = true) {
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  const d = new Diagnostics(g);
  ns.windTunnel = wind;
  g.openX = wind;
  ns.inletSpeed = 120 / 50;
  ns.visc = 0.006;
  ns.seedFreestream();
  return { g, ns, d };
}

function runNS(ctx, frames, targetCFL = 1.0, speed = 1.4) {
  const { g, ns, d } = ctx;
  let dtLast = 0;
  for (let f = 0; f < frames; f++) {
    const uMax = ns.measureMaxSpeed();
    const steps = Math.max(1, Math.ceil(speed));   // matches main.js: scale <= 1
    const scale = speed / steps;
    let dt = uMax > 1e-6 ? (targetCFL * scale) / uMax : 0.4;
    dt = Math.min(0.4, Math.max(1e-4, dt));
    dtLast = dt;
    for (let k = 0; k < steps; k++) ns.step(dt, PALETTE);
    ns.dyeStep(dt * steps);
    d.forces(ns.inletSpeed, ns.visc, dt);
    d.integrals(dt, ns.visc, ns.meanNut, 1);
    d.trackShedding(dt * steps, ns.inletSpeed);
  }
  return dtLast;
}

console.log('\n=== 1. Dye field must stay bounded (the aliasing regression) ===');
{
  const ctx = makeNS(256, 128, true);
  loadScenario(ctx.g, 'cylinder');
  ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
  const trace = [];
  for (let seg = 0; seg < 6; seg++) { runNS(ctx, 50); trace.push(stats(ctx.g.dR).max.toFixed(3)); }
  const last = stats(ctx.g.dR).max;
  console.log(`  dye max over 300 frames: ${trace.join(' ')}`);
  ok(last <= 1.0001, 'dye stays within [0,1]', `max=${last}`);
  ok(clean(ctx.g.dR).ok, 'dye finite');
  ok(clean(ctx.g.u).ok && clean(ctx.g.v).ok, 'velocity finite');
  ok(clean(ctx.g.p).ok, 'pressure finite');
}

console.log('\n=== 2. CFL tracks its target ===');
{
  for (const target of [0.5, 1.0, 2.0]) {
    const ctx = makeNS(256, 128, true);
  loadScenario(ctx.g, 'cylinder');
    ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
    runNS(ctx, 150, target, 1.0);
    const err = Math.abs(ctx.d.cfl - target) / target;
    ok(err < 0.35, `target CFL ${target} -> measured ${ctx.d.cfl.toFixed(3)}`, `err ${(err * 100).toFixed(0)}%`);
  }
}

console.log('\n=== 3. Cylinder drag positive, lift ~zero ===');
{
  const ctx = makeNS(256, 128, true);
  loadScenario(ctx.g, 'cylinder');
  ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
  ctx.ns.visc = 0.08;
  runNS(ctx, 250);                          // let the wake establish
  // A shedding cylinder has an oscillating instantaneous lift; the physically
  // meaningful statement is that its TIME AVERAGE is zero.
  const cl = [], cd = [];
  for (let f = 0; f < 1500; f++) { runNS(ctx, 1); cl.push(ctx.d.cl); cd.push(ctx.d.cd); }
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rms = a => { const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
  const clM = mean(cl), cdM = mean(cd), clF = rms(cl);
  const posFrac = cl.filter(x => x > 0).length / cl.length;
  console.log(`  Cd mean=${cdM.toFixed(3)}  Cl mean=${clM.toFixed(3)} +/- ${clF.toFixed(3)} rms  ${(posFrac * 100).toFixed(0)}% positive  Re=${ctx.d.re.toFixed(0)}  ${ctx.d.regime}`);
  ok(cdM > 0, 'mean drag is positive', `Cd=${cdM.toFixed(3)}`);
  ok(cdM > 0.4 && cdM < 2.5, 'mean drag is physically plausible', `Cd=${cdM.toFixed(3)}`);
  // A shedding cylinder's instantaneous lift oscillates; the physical claim is
  // that the mean is small NEXT TO that oscillation, not small in absolute
  // terms. Averaging a fixed frame count over a non-integer number of shedding
  // periods always leaves a residual, so compare against the amplitude.
  ok(Math.abs(clM) < clF, 'mean lift is small relative to the shedding amplitude',
    `|mean|=${Math.abs(clM).toFixed(3)} vs rms=${clF.toFixed(3)}`);
  ok(posFrac > 0.25 && posFrac < 0.75, 'lift oscillates through zero rather than sitting on one side',
    `${(posFrac * 100).toFixed(0)}% positive`);
}

console.log('\n=== 4. Cambered aerofoil lifts, and lift grows with incidence ===');
{
  const lifts = [];
  for (const aoa of [0, 6, 12]) {
    const ctx = makeNS(256, 128, true);
    loadScenario(ctx.g, 'airfoil-cambered', aoa);
    ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
    ctx.ns.visc = 0.05;
    runNS(ctx, 250);
    const cl = [];
    for (let f = 0; f < 300; f++) { runNS(ctx, 1); cl.push(ctx.d.cl); }
    const m = cl.reduce((x, y) => x + y, 0) / cl.length;
    lifts.push(m);
    console.log(`  aoa=${String(aoa).padStart(2)}deg  Cl mean=${m.toFixed(3)}  Cd=${ctx.d.cd.toFixed(3)}`);
  }
  ok(lifts[0] > 0, 'cambered section lifts at zero incidence', `Cl=${lifts[0].toFixed(3)}`);
  ok(lifts[0] > 0.05 && lifts[0] < 0.8, 'zero-incidence lift is the right order (NACA 2412 ~ 0.25)', `Cl=${lifts[0].toFixed(3)}`);
  ok(lifts[1] > lifts[0], 'lift increases from 0 to 6 deg');
  ok(lifts[2] > lifts[0], 'lift at 12 deg exceeds 0 deg');
}

console.log('\n=== 5. Projection actually removes divergence ===');
{
  const ctx = makeNS(256, 128, true);
  loadScenario(ctx.g, 'cylinder');
  ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
  runNS(ctx, 120);
  const { g, ns } = ctx;
  const { nx, ny, stride: s, u, v, solid } = g;
  const uref = ns.inletSpeed;

  const measure = (skipNearBody) => {
    let acc = 0, n = 0;
    for (let j = 2; j <= ny - 1; j++) for (let i = 2; i <= nx - 1; i++) {
      const k = i + j * s;
      if (solid[k]) continue;
      if (skipNearBody && (solid[k - 1] || solid[k + 1] || solid[k - s] || solid[k + s])) continue;
      const d = 0.5 * (u[k + 1] - u[k - 1] + v[k + s] - v[k - s]);
      acc += d * d; n++;
    }
    return Math.sqrt(acc / n);
  };
  const all = measure(false), interior = measure(true);
  const poissonRes = ns.poisson.residualRMS(g.p, g.div);

  console.log(`  poisson residual  = ${poissonRes.toExponential(2)}`);
  console.log(`  rms div (all)     = ${all.toExponential(2)}  (${(all / uref * 100).toFixed(3)}% of inlet)`);
  console.log(`  rms div (off-wall)= ${interior.toExponential(2)}  (${(interior / uref * 100).toFixed(3)}% of inlet)`);
  ok(interior / uref < 0.02, 'off-wall divergence is small', `${(interior / uref * 100).toFixed(3)}%`);
  ok(all / uref < 0.05, 'overall divergence is small', `${(all / uref * 100).toFixed(3)}%`);
}

console.log('\n=== 6. Diffusion solve converges with the tuned relaxation factor ===');
{
  const g = new Grid(128, 64);
  const ns = new NavierStokes(g);
  const n = g.size, s = g.stride;
  const src = new Float32Array(n), out = new Float32Array(n);
  for (let j = 1; j <= g.ny; j++) for (let i = 1; i <= g.nx; i++) src[i + j * s] = Math.sin(i * 0.2) * Math.cos(j * 0.2);
  for (const coeff of [0.006, 0.05, 0.3]) {
    const dt = 0.1, a = coeff * dt;
    out.set(src);                       // diffuse expects x seeded with x0
    ns.diffuse(0, out, src, coeff, dt);
    let res = 0, cnt = 0;
    for (let j = 3; j <= g.ny - 2; j++) for (let i = 3; i <= g.nx - 2; i++) {
      const k = i + j * s;
      const r = src[k] - ((1 + 4 * a) * out[k] - a * (out[k - 1] + out[k + 1] + out[k - s] + out[k + s]));
      res += r * r; cnt++;
    }
    const rms = Math.sqrt(res / cnt);
    console.log(`  coeff=${coeff.toFixed(3)}  a=${a.toFixed(4)}  omega=${NavierStokes.diffusionOmega(a).toFixed(3)}  rms residual=${rms.toExponential(2)}`);
    ok(rms < 5e-3, `diffusion converges at coeff=${coeff}`, `rms=${rms.toExponential(2)}`);
  }
}

console.log('\n=== 7. Lattice Boltzmann ===');
{
  const g = new Grid(256, 128);
  const lbm = new LatticeBoltzmann(g);
  const ns = new NavierStokes(g);
  const d = new Diagnostics(g);
  lbm.windTunnel = true; g.openX = true; lbm.inletSpeed = 0.086; lbm.steps = 8;
  loadScenario(g, 'cylinder');
  g.refreshSolidFlag(); if (ns.windTunnel) ns.seedFreestream();
  for (let f = 0; f < 120; f++) {
    const el = lbm.step(PALETTE);
    ns.dyeStep(el);
    d.forces(lbm.inletSpeed, lbm.viscosity, 1);
    d.integrals(1, lbm.viscosity, lbm.meanNut, 0.5773);
  }
  console.log(`  |u|max=${stats(g.u).max.toFixed(4)}  rho in [${Math.min(...g.rho.slice(0, 2000)).toFixed(3)}, ${stats(g.rho).max.toFixed(3)}]`);
  console.log(`  Cd=${d.cd.toFixed(3)}  Cl=${d.cl.toFixed(3)}  Re=${d.re.toFixed(0)}  dye max=${stats(g.dR).max.toFixed(3)}`);
  ok(clean(g.u).ok && clean(g.v).ok, 'LBM velocity finite');
  ok(stats(g.u).max < 0.25, 'LBM velocity within the Mach limit', `max=${stats(g.u).max.toFixed(3)}`);
  ok(stats(g.dR).max <= 1.0001, 'LBM dye bounded');
  ok(d.cd > 0, 'LBM drag positive', `Cd=${d.cd.toFixed(3)}`);
}

console.log('\n=== 8. LBM force scaling is not divided away ===');
{
  const g = new Grid(96, 48);
  const lbm = new LatticeBoltzmann(g);
  lbm.windTunnel = false; lbm.steps = 8;
  lbm.initEquilibrium();
  const s = g.stride, mid = 48 + 24 * s;
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) g.fx[mid + di + dj * s] = 0.02;
  lbm.step(PALETTE);
  const reached = Math.abs(g.u[mid]);
  console.log(`  applied fx=0.02 over a 7x7 patch -> |u| at centre = ${reached.toExponential(2)}`);
  ok(reached > 1e-3, 'a user impulse produces a visible velocity', `|u|=${reached.toExponential(2)}`);
}

console.log('\n=== 9. Every scenario builds without error ===');
{
  for (const sc of SCENARIOS) {
    const g = new Grid(256, 128);
    const ns = new NavierStokes(g);
    const d = new Diagnostics(g);
    let err = null, cells = 0, emitters = 0, water = null;
    try {
      ns.windTunnel = sc.wind; g.openX = sc.wind; ns.inletSpeed = 2.4;
      ns.speedCap = 2.4 * 25;
      const { scene } = loadScenario(g, sc.id);
      ns.onGeometryChanged();
      if (ns.windTunnel) ns.seedFreestream();
      for (let i = 0; i < g.solid.length; i++) cells += g.solid[i];

      /* A water scenario carries its content in the FILL, not in geometry — a
       * tank is a tank whether or not anything is floating in it. Driving one
       * as airflow and then complaining it has no solid cells tests nothing;
       * running the surface and checking the water is still there tests what
       * the scenario is actually for. */
      if (sc.physics === 'water') {
        const fs = new FreeSurface(g);
        fs.enabled = true; fs.mac = ns.mac;
        ns.windTunnel = false; g.openX = false;
        ns.vorticity = 0; ns.les = false; ns.visc = 0.05;
        fs.preset(sc.water);
        const v0 = fs.volume();
        for (let f = 0; f < 90; f++) {
          const uMax = ns.measureMaxSpeed();
          const dt = Math.min(0.15, Math.max(1e-3, 1 / Math.max(uMax, 1e-6)));
          fs.syncAir(); fs.preProject(dt); ns.step(dt, PALETTE); fs.postProject(dt);
        }
        const v1 = fs.volume();
        water = `${v0.toFixed(0)} -> ${v1.toFixed(0)}`;
        if (!clean(g.u).ok || !clean(g.v).ok) err = 'non-finite field';
        else if (!(v0 > 0)) err = 'scenario laid down no water';
        else if (!(v1 > v0 * 0.85)) err = `water drained away (${water})`;
      } else {

      // Emitters, mirroring main.js: scene objects whose role is `inlet`,
      // relaxing the flow toward a target velocity.
      const inlets = scene.objects.filter(o => o.boundary === 'inlet').map(o => {
        const b = T.bounds(o);
        const a = (o.bcParams.direction || 0) * Math.PI / 180;
        return {
          i: Math.round(o.transform.x), j: Math.round(o.transform.y),
          radius: Math.max(2, Math.round(Math.min(b.maxX - b.minX, b.maxY - b.minY) / 2)),
          ux: Math.cos(a) * (o.bcParams.speed ?? 1), uy: Math.sin(a) * (o.bcParams.speed ?? 1),
          strength: o.bcParams.strength ?? 14,
        };
      });
      emitters = inlets.length;
      const emit = () => {
        for (const src of inlets) {
          const r = src.radius;
          const rate = Math.min(0.8, Math.max(0.1, src.strength / 20));
          const tx = src.ux * 2.4, ty = src.uy * 2.4;
          for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
            const d2 = di * di + dj * dj;
            if (d2 > r * r) continue;
            const i = src.i + di, j = src.j + dj;
            if (i < 1 || i > g.nx || j < 1 || j > g.ny) continue;
            const idx = i + j * g.stride;
            if (g.solid[idx]) continue;
            const a = (1 - Math.sqrt(d2) / (r + 1)) * rate;
            g.fx[idx] += (tx - g.u[idx]) * a;
            g.fy[idx] += (ty - g.v[idx]) * a;
          }
        }
      };
      for (let f = 0; f < 120; f++) { emit(); runNS({ g, ns, d }, 1); }
      if (!clean(g.u).ok || !clean(g.v).ok || !clean(g.dR).ok) err = 'non-finite field';
      if (stats(g.dR).max > 1.0001) err = 'dye out of range';
      if (cells === 0 && emitters === 0) err = 'scenario produced no geometry';
      }
    } catch (e) { err = e.message; }
    ok(!err, water
      ? `${sc.id.padEnd(18)} water=${water.padStart(14)}  solid=${String(cells).padStart(5)}`
      : `${sc.id.padEnd(18)} solid=${String(cells).padStart(5)}  emitters=${emitters}`,
      err || '');
  }
}

console.log('\n=== 10. Particles ===');
{
  const ctx = makeNS(256, 128, true);
  loadScenario(ctx.g, 'cylinder');
  ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
  const p = new Particles(ctx.g, PALETTE, 1400, 14);
  p.seed(true);
  for (let f = 0; f < 200; f++) { const dt = runNS(ctx, 1); p.advect(dt * 1.4); }
  let inside = 0, trailed = 0;
  for (let k = 0; k < p.count; k++) {
    if (p.px[k] >= 1 && p.px[k] <= ctx.g.nx && p.py[k] >= 1 && p.py[k] <= ctx.g.ny) inside++;
    if (p.len[k] > 1) trailed++;
  }
  console.log(`  ${inside}/${p.count} in domain, ${trailed} with trails`);
  ok(inside === p.count, 'all particles stay in the domain');
  ok(trailed > p.count * 0.5, 'most particles have trails');
}

console.log('\n=== 11. Performance ===');
{
  for (const [nx, ny] of [[192, 96], [256, 128], [384, 192]]) {
    const ctx = makeNS(nx, ny, true);
  loadScenario(ctx.g, 'cylinder');
    ctx.g.refreshSolidFlag(); ctx.ns.onGeometryChanged(); ctx.ns.seedFreestream();
    runNS(ctx, 30);                       // warm the JIT
    const t0 = performance.now();
    runNS(ctx, 100, 1.0, 1.4);
    const ms = (performance.now() - t0) / 100;
    console.log(`  ${String(nx + 'x' + ny).padEnd(9)} ${ms.toFixed(2)} ms/frame solver-only  (${(1000 / ms).toFixed(0)} fps ceiling)`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);


