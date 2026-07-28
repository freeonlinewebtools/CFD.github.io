/* The staggered (MAC) solver.
 *
 * This suite exists because the LAST attempt at a staggered solver passed the
 * obvious test and still had to be reverted. It halved the divergence, exactly
 * as theory predicts, and destroyed the physics: cylinder Cd 1.25 -> 0.59,
 * shedding amplitude 0.90 -> 0.10. "The residual improved" is therefore not
 * evidence of anything on its own, and neither is a green run here —
 * tests/validate.mjs is the gate that matters.
 *
 * What this file checks is the part validate.mjs cannot see: that the discrete
 * operators are what they claim to be. If div and grad are exact adjoints then
 * one projection removes the divergence to solver tolerance and MORE cycles
 * make it smaller, monotonically. Under the collocated form that was not true —
 * a ragged boundary could take the residual from 5.5 to 594 by adding V-cycles,
 * which is what converging accurately onto an inconsistent operator looks like.
 */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); }
};

/* Peak |compact divergence| over the fluid — the quantity the staggered
 * projection actually solves for, and so the only fair measure of it. */
function maxDiv(g) {
  const { nx, ny, stride: s, uf, vf, solid } = g;
  let m = 0;
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx; i++) {
      const idx = i + j * s;
      if (solid[idx]) continue;
      const d = Math.abs((uf[idx + 1] - uf[idx]) + (vf[idx + s] - vf[idx]));
      if (d > m) m = d;
    }
  return m;
}

function makeNS(nx = 64, ny = 64) {
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  ns.mac = true;
  ns.les = false; ns.vorticity = 0; ns.visc = 0;
  ns.speedCap = 0;
  return { g, ns };
}

console.log('=== 1. div and grad are exact adjoints ===');
/* The property the whole rewrite rests on. For random fields a and b,
 *     <div(a), b>  ==  -<a, grad(b)>
 * to floating-point noise. If this fails, the projection is inverting an
 * operator that is not the composition of the two it uses, and no amount of
 * solver tuning will fix the consequences. */
{
  const { g } = makeNS(32, 32);
  const { nx, ny, stride: s, uf, vf } = g;
  // Deterministic pseudo-random, so a failure is reproducible.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };

  const b = new Float32Array(g.size);
  for (let i = 0; i < g.size; i++) { uf[i] = rnd(); vf[i] = rnd(); b[i] = rnd(); }
  // Faces on the domain boundary are constrained, not free unknowns; zero them
  // so both sides of the identity see the same space.
  for (let j = 1; j <= ny; j++) { uf[1 + j * s] = 0; uf[nx + 1 + j * s] = 0; }
  for (let i = 1; i <= nx; i++) { vf[i + s] = 0; vf[i + (ny + 1) * s] = 0; }

  let lhs = 0;
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx; i++) {
      const idx = i + j * s;
      lhs += ((uf[idx + 1] - uf[idx]) + (vf[idx + s] - vf[idx])) * b[idx];
    }

  let rhs = 0;
  for (let j = 1; j <= ny; j++)
    for (let i = 2; i <= nx; i++) {
      const idx = i + j * s;
      rhs += uf[idx] * (b[idx] - b[idx - 1]);
    }
  for (let j = 2; j <= ny; j++)
    for (let i = 1; i <= nx; i++) {
      const idx = i + j * s;
      rhs += vf[idx] * (b[idx] - b[idx - s]);
    }

  const err = Math.abs(lhs + rhs) / Math.max(Math.abs(lhs), 1e-9);
  console.log(`    <div a, b> = ${lhs.toFixed(6)},  -<a, grad b> = ${(-rhs).toFixed(6)}`);
  ok(err < 1e-4, 'the operators are adjoint to round-off', err.toExponential(2));
}

console.log('\n=== 2. One projection removes the divergence ===');
{
  const { g, ns } = makeNS(64, 64);
  const { nx, ny, stride: s, uf, vf } = g;
  let seed = 999;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx + 1; i++) uf[i + j * s] = rnd() * 2;
  for (let j = 1; j <= ny + 1; j++)
    for (let i = 1; i <= nx; i++) vf[i + j * s] = rnd() * 2;
  g.setBndFaces();

  /* White noise on the faces is the worst case a multigrid can be handed — the
   * error is entirely at the grid scale, where coarse levels cannot help — so
   * the cycle count is set to what actually converges it rather than to what
   * the solver uses on the smooth fields real flow produces. The point being
   * tested is that it converges at all, and to a small number. */
  const before = maxDiv(g);
  ns.project(20);
  const after = maxDiv(g);
  console.log(`    peak |div| ${before.toFixed(4)} -> ${after.toExponential(3)}`);
  ok(after < before * 0.02, 'a noisy field is made near-solenoidal',
    `${before.toFixed(4)} -> ${after.toExponential(3)}`);
}

console.log('\n=== 3. More cycles converge, they do not diverge ===');
/* The collocated failure mode, stated as a test. Adding V-cycles to an
 * inconsistent operator pair converges harder onto the wrong answer; with a
 * consistent pair it simply gets better. Run the SAME initial field at several
 * cycle counts and require the result to improve monotonically. */
{
  const results = [];
  for (const cycles of [1, 2, 4, 8]) {
    const { g, ns } = makeNS(64, 64);
    const { nx, ny, stride: s, uf, vf, solid } = g;
    // A ragged solid, which is the geometry that provoked the runaway.
    for (let j = 20; j < 44; j++)
      for (let i = 20; i < 44; i++) {
        const r = Math.hypot(i - 32, j - 32) + ((i * 7 + j * 13) % 5) * 0.4;
        if (r < 10) solid[i + j * s] = 1;
      }
    g.refreshSolidFlag();
    ns.onGeometryChanged();

    let seed = 4242;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx + 1; i++) uf[i + j * s] = 1 + rnd();
    for (let j = 1; j <= ny + 1; j++)
      for (let i = 1; i <= nx; i++) vf[i + j * s] = rnd();
    g.setBndFaces();

    ns.project(cycles);
    results.push({ cycles, div: maxDiv(g) });
    console.log(`    ${String(cycles).padStart(2)} cycles -> peak |div| ${maxDiv(g).toExponential(3)}`);
  }
  let monotone = true;
  for (let i = 1; i < results.length; i++) {
    if (results[i].div > results[i - 1].div * 1.05) monotone = false;
  }
  ok(monotone, 'more V-cycles never make the divergence worse',
    results.map(r => `${r.cycles}:${r.div.toExponential(1)}`).join(' '));
  ok(results[3].div < results[0].div, 'and eight beats one',
    `${results[0].div.toExponential(2)} -> ${results[3].div.toExponential(2)}`);
}

console.log('\n=== 4. A sealed box does not diverge ===');
/* Limitation 2 in CONTEXT.md: any fully sealed region driven from inside went
 * non-finite in 25-50 steps, which is why lid-cavity is commented out of
 * scenarios.js. The cause was named as the collocated projection. */
{
  const { g, ns } = makeNS(48, 48);
  const { nx, ny, stride: s, uf } = g;
  ns.visc = 0.01;
  g.openX = false;
  let worst = 0, finite = true;
  for (let k = 0; k < 300; k++) {
    // Drive the top row like a lid.
    for (let i = 1; i <= nx + 1; i++) uf[i + 1 * s] = 1.0;
    ns.step(0.2, []);
    const d = maxDiv(g);
    if (d > worst) worst = d;
    for (let i = 0; i < g.size; i++) {
      if (!Number.isFinite(g.uf[i]) || !Number.isFinite(g.vf[i])) { finite = false; break; }
    }
    if (!finite) { console.log(`    went non-finite at step ${k}`); break; }
  }
  console.log(`    300 steps, worst peak |div| ${worst.toExponential(3)}`);
  ok(finite, 'a driven closed box stays finite for 300 steps');
  ok(worst < 1.0, 'and its divergence stays bounded', worst.toExponential(3));
}

console.log('\n=== 5. Vorticity survives the step ===');
/* The failure that killed the previous attempt, isolated. A Taylor-Green vortex
 * is an exact solution of the inviscid equations, so its peak vorticity should
 * decay only through numerical dissipation. The reverted "minimal MAC" applied
 * a low-pass filter twice per step, which showed up here as a rout. */
{
  const { g, ns } = makeNS(64, 64);
  ns.visc = 0; ns.vorticity = 0; ns.les = false;
  const { nx, ny, stride: s, uf, vf } = g;
  const k = 2 * Math.PI / nx;
  for (let j = 0; j <= ny + 1; j++)
    for (let i = 0; i <= nx + 1; i++) {
      const idx = i + j * s;
      uf[idx] = Math.sin(k * (i - 0.5)) * Math.cos(k * j);
      vf[idx] = -Math.cos(k * i) * Math.sin(k * (j - 0.5));
    }
  g.setBndFaces();

  const curl = () => {
    let m = 0;
    for (let j = 2; j <= ny - 1; j++)
      for (let i = 2; i <= nx - 1; i++) {
        const idx = i + j * s;
        const w = (vf[idx + 1] - vf[idx]) - (uf[idx + s] - uf[idx]);
        if (Math.abs(w) > m) m = Math.abs(w);
      }
    return m;
  };
  const energy = () => {
    let e = 0;
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) {
        const idx = i + j * s;
        e += uf[idx] * uf[idx] + vf[idx] * vf[idx];
      }
    return e;
  };
  const w0 = curl(), e0 = energy();
  for (let n = 0; n < 200; n++) ns.step(0.05, []);
  const w1 = curl(), e1 = energy();
  const kept = w1 / w0, keptE = e1 / e0;
  console.log(`    peak |curl| ${w0.toFixed(4)} -> ${w1.toFixed(4)}  (${(kept * 100).toFixed(1)}% over 200 steps)`);
  console.log(`    kinetic energy ${e0.toFixed(0)} -> ${e1.toFixed(0)}  (${(keptE * 100).toFixed(1)}%)`);
  /* Two failure modes, opposite in sign, and the vortex catches both.
   *
   * Too little and the scheme is diffusive — the reverted attempt's filter was
   * (1+2+1)/4 applied twice per step, which erases this wavelength entirely.
   * Too much and it is unstable: a shared pressure buffer between the two
   * projections took the energy to 600% of its start in forty steps. An exact
   * inviscid solution should hold both very nearly constant. */
  ok(kept > 0.8, 'a Taylor-Green vortex keeps its strength', `${(kept * 100).toFixed(1)}%`);
  ok(keptE > 0.9 && keptE < 1.05, 'and its energy neither decays nor grows',
    `${(keptE * 100).toFixed(1)}%`);
}

console.log('\n=== 6. Confinement and the SGS model reach the faces intact ===');
/* The bug this exists for, and the reason it is a separate case:
 *
 * The cell-centred passes (confinement, Smagorinsky, porous drag, the sponge)
 * run on the mirror and reach the faces as an INCREMENT — snapshot the mirror,
 * let them work, difference, scatter. The snapshot first went into `g.t1`, and
 * `vorticityConfinement` takes `t1` as its own curl scratch and overwrites it on
 * entry. So the "increment" was `u - curl`: the entire velocity field, scattered
 * onto the faces every step. It ran away within ten steps.
 *
 * It survived every other suite because validate.mjs, water.mjs and the cases
 * above all set `vorticity = 0`, while the APP defaults it to 1. A test that
 * turns the feature off cannot catch a bug in the feature.
 *
 * So this runs with confinement ON and the speed cap OFF — with the cap on, a
 * runaway is clamped into something that merely looks poor rather than
 * obviously broken, which is exactly how it went unnoticed. */
{
  const { PALETTE } = await import(B + 'colormaps.js');
  for (const [vort, les, label] of [[1.0, false, 'confinement'], [1.0, true, 'confinement + LES']]) {
    const g = new Grid(192, 96);
    const ns = new NavierStokes(g);
    ns.mac = true;
    ns.windTunnel = true; g.openX = true; ns.inletSpeed = 2.4; ns.visc = 0.02;
    ns.speedCap = 0;                       // no net: a runaway must show as one
    ns.vorticity = vort; ns.les = les;
    const s = g.stride;
    for (let j = 1; j <= 96; j++)
      for (let i = 1; i <= 192; i++)
        if (Math.hypot(i - 55, j - 48) < 14) g.solid[i + j * s] = 1;
    g.refreshSolidFlag(); ns.onGeometryChanged(); ns.seedFreestream();

    let worst = 0;
    for (let k = 0; k < 400; k++) {
      const uMax = ns.measureMaxSpeed();
      const dt = Math.min(0.4, Math.max(1e-4, uMax > 1e-6 ? 1 / uMax : 0.4));
      ns.step(dt, PALETTE);
      for (let i = 0; i < g.size; i++) {
        const m = Math.hypot(g.u[i], g.v[i]);
        if (m > worst) worst = m;
      }
      if (!Number.isFinite(worst)) break;
    }
    console.log(`    ${label.padEnd(18)} peak |u| ${worst.toExponential(2)} over 400 uncapped steps`);
    // A healthy tunnel peaks around 2-3x the inlet past a cylinder. Ten times
    // it is not a near miss, it is a different regime.
    ok(Number.isFinite(worst) && worst < 24,
      `${label} stays bounded without the speed cap`, worst.toExponential(2));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
