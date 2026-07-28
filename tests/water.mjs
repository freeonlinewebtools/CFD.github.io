/* Free-surface water.
 *
 * Physics with known answers, not eyeballing: a body of water under gravity
 * settles FLAT and stays put, a column released collapses and spreads, and the
 * total volume does not drain away. Each of those fails in a different, telling
 * way if the free-surface pressure condition is wrong — the commonest symptom
 * being water that sits under an invisible lid because the air cells kept a
 * zero-gradient (wall) condition instead of a Dirichlet one.
 */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { FreeSurface, FULL } = await import(B + 'freesurface.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); }
};

function makeTank(nx = 96, ny = 64) {
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  ns.windTunnel = false; g.openX = false;
  ns.visc = 0.02; ns.les = false; ns.vorticity = 0;
  ns.speedCap = 40; ns.dyeFade = 1;
  const fs = new FreeSurface(g);
  fs.enabled = true;
  // The staggered solver by default, matching the app; COLLOCATED=1 for the old
  // path. Gravity is the one part of the surface that writes to the solver's
  // state instead of reading it, so it is the one part that has to know which
  // grid is authoritative.
  ns.mac = process.env.COLLOCATED !== '1';
  fs.mac = ns.mac;
  return { g, ns, fs };
}

/* One step with the surface wrapped around the solver, as main.js will do.
 *
 * The timestep is derived from the peak speed, exactly as the app's loop does.
 * A fixed dt is wrong here in a way that is easy to miss: water in free fall
 * accelerates without bound until it lands, so a step that is comfortable at
 * rest reaches CFL ~ 6 by the time a dropped blob arrives, and the advection —
 * whose limiter is designed for CFL ~ 1 — smears it away to nothing. */
function step({ g, ns, fs }, rate = 1) {
  const uMax = ns.measureMaxSpeed();
  const dt = Math.min(0.15 * rate, Math.max(1e-3, (1 / Math.max(uMax, 1e-6)) * rate));
  g.hasAir = true;
  const { nx, ny, stride: s } = g;
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx; i++) {
      const idx = i + j * s;
      g.air[idx] = fs.fill[idx] < FULL ? 1 : 0;
    }
  fs.preProject(dt);
  ns.step(dt, []);
  fs.postProject(dt);
}

/* Mean surface height, measured as the lowest filled row per column. j runs
 * DOWN, so a larger number is lower. */
function surfaceRows(g, fs) {
  const { nx, ny, stride: s } = g;
  const rows = [];
  for (let i = 1; i <= nx; i++) {
    let top = ny + 1;
    for (let j = 1; j <= ny; j++) if (fs.fill[i + j * s] >= FULL) { top = j; break; }
    rows.push(top);
  }
  return rows;
}
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const spread = a => Math.max(...a) - Math.min(...a);

console.log('=== 1. A flat pool stays flat ===');
/* The single most diagnostic case. Water at rest under gravity must stay at
 * rest: the pressure gradient exactly balances gravity. If the air cells are
 * Neumann instead of Dirichlet the surface is held down by a lid and nothing
 * moves either — so this is checked together with the column test below, which
 * only passes if the surface can actually move. */
{
  const t = makeTank();
  t.fs.reset(0.5);
  const before = mean(surfaceRows(t.g, t.fs));
  const v0 = t.fs.volume();
  for (let k = 0; k < 200; k++) step(t);
  const rows = surfaceRows(t.g, t.fs);
  const after = mean(rows);
  console.log(`    surface row ${before.toFixed(2)} -> ${after.toFixed(2)}, unevenness ${spread(rows)}`);
  ok(Math.abs(after - before) < 2, 'the level does not drift', `${before.toFixed(2)} -> ${after.toFixed(2)}`);
  ok(spread(rows) <= 2, 'and stays flat across the tank', `spread ${spread(rows)} rows`);
  const drift = Math.abs(t.fs.volume() - v0) / v0;
  ok(drift < 0.02, 'volume holds to 2% over 200 steps', `${(drift * 100).toFixed(2)}%`);
}

console.log('\n=== 2. A column collapses and spreads ===');
/* This is what fails if the surface is not free: with a wall condition on the
 * air the column simply stands there. */
{
  const t = makeTank(120, 64);
  const { g, fs } = t;
  const { nx, ny, stride: s } = g;
  fs.ensureSize();
  fs.fill.fill(0);
  // A tall block against the left wall — the classic dam break.
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx; i++)
      if (i <= nx * 0.25 && j > ny * 0.25) fs.fill[i + j * s] = 1;
  fs.targetVolume = fs.volume();
  fs.classify();
  const v0 = fs.volume();

  const wetted = () => {
    let far = 0;
    for (let i = 1; i <= nx; i++)
      for (let j = 1; j <= ny; j++)
        if (fs.fill[i + j * s] >= FULL) { if (i > far) far = i; break; }
    return far;
  };
  const startFront = wetted();
  for (let k = 0; k < 300; k++) step(t);
  const endFront = wetted();
  console.log(`    wetted front ${startFront} -> ${endFront} of ${nx} columns`);
  ok(endFront > startFront + 8, 'the column collapses and runs along the floor',
    `${startFront} -> ${endFront}`);
  let finite = true;
  for (let i = 0; i < g.size; i++) if (!Number.isFinite(g.u[i]) || !Number.isFinite(g.v[i])) finite = false;
  ok(finite, 'and the field stays finite');
  const drift = Math.abs(fs.volume() - v0) / v0;
  ok(drift < 0.06, 'volume holds to 6% through the collapse', `${(drift * 100).toFixed(2)}%`);
}

console.log('\n=== 3. Water falls under gravity ===');
{
  const t = makeTank(64, 96);
  const { g, fs } = t;
  const { nx, ny, stride: s } = g;
  fs.ensureSize();
  fs.fill.fill(0);
  // A blob held high in the domain.
  for (let j = 1; j <= ny; j++)
    for (let i = 1; i <= nx; i++) {
      const dx = i - nx / 2, dy = j - ny * 0.25;
      if (dx * dx + dy * dy < 12 * 12) fs.fill[i + j * s] = 1;
    }
  fs.targetVolume = fs.volume();
  fs.classify();

  const centroid = () => {
    let sy = 0, n = 0;
    for (let j = 1; j <= ny; j++)
      for (let i = 1; i <= nx; i++) {
        const f = fs.fill[i + j * s];
        if (f >= FULL) { sy += j; n++; }
      }
    return n ? sy / n : 0;
  };
  const y0 = centroid();
  for (let k = 0; k < 120; k++) step(t);
  const y1 = centroid();
  console.log(`    centroid row ${y0.toFixed(1)} -> ${y1.toFixed(1)} (larger is lower)`);
  ok(y1 > y0 + 4, 'the blob falls', `${y0.toFixed(1)} -> ${y1.toFixed(1)}`);
}

console.log('\n=== 4. Air cells are a Dirichlet condition, solids are not ===');
/* The distinction the whole feature rests on: a solid neighbour is excluded
 * from the pressure stencil, an air neighbour is counted in it holding p = 0. */
{
  const g = new Grid(32, 32);
  const ns = new NavierStokes(g);
  const s = g.stride;
  const centre = 16 + 16 * s;

  g.solid.fill(0); g.air.fill(0);
  g.solid[centre + 1] = 1; g.refreshSolidFlag();
  g.hasAir = false;
  ns.poisson.dirty = true;
  ns.poisson.ensureTopology();
  const withSolid = ns.poisson.levels[0].nf[centre];

  g.solid.fill(0); g.refreshSolidFlag();
  g.air[centre + 1] = 1; g.hasAir = true;
  ns.poisson.dirty = true;
  ns.poisson.ensureTopology();
  ns.poisson.countNeighbours(ns.poisson.levels[0], g.air);
  const withAir = ns.poisson.levels[0].nf[centre];

  console.log(`    diagonal with a solid neighbour ${withSolid}, with an air neighbour ${withAir}`);
  ok(withSolid === 3, 'a solid neighbour is dropped from the stencil', String(withSolid));
  ok(withAir === 4, 'an air neighbour is kept, holding p = 0', String(withAir));
}

console.log('\n=== 5. A free surface leaves no trace once it is gone ===');
/* Turning water off must return the solver to exactly what airflow expects.
 * The finest-level pressure stencil is rebuilt every solve while a surface
 * exists; if nothing rebuilds it afterwards the air simulation keeps solving
 * against a diagonal that counts air cells nobody has any more, and there is
 * nothing on screen to say why the answers changed. */
{
  const g = new Grid(48, 48);
  const ns = new NavierStokes(g);
  const s = g.stride;
  const centre = 24 + 24 * s;

  /* Probe the cell that is MADE air, not one beside it.
   *
   * A water cell next to air keeps a diagonal of 4 either way — that is the
   * whole point of the Dirichlet condition — so probing a neighbour cannot tell
   * a restored stencil from a stale one. The air cell itself goes from 4 to 0
   * (skipped by the smoother) and back, which is the difference that matters. */
  const stencilAt = () => ns.poisson.levels[0].nf[centre];
  const solveOnce = () => { g.div.fill(0); ns.poisson.solve(g.p, g.div, 1); };

  g.solid.fill(0); g.air.fill(0); g.hasAir = false;
  g.refreshSolidFlag();
  ns.poisson.dirty = true;
  solveOnce();
  const clean = stencilAt();

  // Make THIS cell air: while a surface exists it is not solved at all.
  g.air[centre] = 1; g.hasAir = true;
  solveOnce();
  const during = stencilAt();

  // Surface gone. Without the restore this keeps the water's stencil.
  g.air.fill(0); g.hasAir = false;
  solveOnce();
  const after = stencilAt();

  console.log(`    diagonal: clean ${clean}, during water ${during}, after ${after}`);
  ok(clean === 4, 'open fluid counts all four neighbours', String(clean));
  ok(during === 0, 'an air cell is dropped from the solve entirely', String(during));
  ok(after === clean, 'the stencil is restored once the surface goes',
    `${after} vs ${clean}`);

  // And a plain airflow solve still behaves: a point source must produce a
  // pressure field, not zeros and not garbage.
  g.p.fill(0); g.div.fill(0);
  g.div[centre] = 1;
  ns.poisson.solve(g.p, g.div, 3);
  let finite = true, spread = 0;
  for (let i = 0; i < g.size; i++) {
    if (!Number.isFinite(g.p[i])) finite = false;
    spread = Math.max(spread, Math.abs(g.p[i]));
  }
  ok(finite, 'the airflow solve stays finite afterwards');
  ok(spread > 1e-6, 'and still responds to a source', spread.toExponential(2));
}

console.log('\n=== 6. The fill field survives a save and load ===');
/* A saved tank that reloads as airflow with no water is not an error anyone
 * sees — the obstacles come back, so the file looks like it loaded. */
{
  const { encodeFill, decodeFill } = await import(B + 'freesurface.js');
  const g = new Grid(96, 64);
  const fs = new FreeSurface(g);
  fs.reset(0.45);
  // A ragged surface, so this is not just testing two constant runs.
  const { nx, stride: s } = g;
  for (let i = 1; i <= nx; i++) fs.fill[i + 30 * s] = (i % 7) / 7;
  const v0 = fs.volume();

  const enc = encodeFill(fs.fill);
  const round = new Float32Array(g.size);
  const n = decodeFill(enc, round);

  ok(n === g.size, 'every cell round-trips', `${n} of ${g.size}`);
  let worst = 0;
  for (let i = 0; i < g.size; i++) worst = Math.max(worst, Math.abs(round[i] - fs.fill[i]));
  ok(worst <= 1 / 255 + 1e-6, 'to within one quantisation step', worst.toExponential(2));

  const back = new FreeSurface(g);
  back.fill.set(round);
  const drift = Math.abs(back.volume() - v0) / v0;
  ok(drift < 1e-3, 'and the volume comes back', `${(drift * 100).toFixed(4)}%`);

  // Compactness is the reason for the encoding; a tank that does not compress
  // would make project files unwieldy.
  const raw = g.size;
  console.log(`    ${enc.length} base64 chars for ${raw} cells (${(enc.length / raw).toFixed(3)} per cell)`);
  ok(enc.length < raw, 'the encoding is smaller than one byte per cell',
    `${enc.length} vs ${raw}`);
}

console.log('\n=== 7. Nothing advances the solver behind the surface’s back ===');
/* The frame recorder once called `ns.step` bare while the live loop wrapped it,
 * so every exported video of a water scene showed a frozen surface over a
 * moving flow. Both now go through `advanceNS`, and this is what stops a third
 * call site appearing without it.
 *
 * The SHAPE of the water branch changed when the particle solver landed —
 * `water.step(dt, ns)` owns the whole cycle now, including calling the
 * projection, because with particles there is no grid advection left to bracket.
 * The invariant is unchanged: one function advances the solver, and it knows
 * which physics is running.
 *
 * main.js cannot be imported here — it wants a DOM — so this reads the source,
 * which is the right level for the invariant anyway: it is a rule about call
 * sites, not about runtime values. */
{
  const { readFileSync } = await import('node:fs');
  /* Normalise line endings before doing anything else. This repo is CRLF, and
   * the extraction below used to look for a bare "\n}\n" — which silently
   * matched nothing, took `indexOf` to -1, and sliced a two-character "helper"
   * that trivially satisfied every check after it. A test that cannot fail is
   * worse than no test, and this one only revealed itself when the code it
   * guards was rewritten. */
  const src = readFileSync(new URL(B + 'main.js', import.meta.url), 'utf8')
    .replace(/\r\n/g, '\n');

  const body = src.slice(src.indexOf('function advanceNS'));
  const end = body.indexOf('\n}\n');
  ok(end > 0, 'the advanceNS helper can be located in main.js', `indexOf gave ${end}`);
  const helper = body.slice(0, end + 3);
  ok(/water\.step\(/.test(helper) && /ns\.step\(/.test(helper),
    'advanceNS dispatches water to the particle solver and air to ns.step');

  /* Every ns.step call outside the helper is a bug waiting to happen.
   *
   * Comments have to come out first — the file discusses `ns.step()` in prose
   * more than once, and matching those reports a stray call that does not
   * exist. A test that cries wolf gets deleted, which is worse than not having
   * it. */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const outside = code.replace(helper.replace(/\/\*[\s\S]*?\*\//g, ''), '');
  const strays = [...outside.matchAll(/\bns\.step\s*\(/g)];
  ok(strays.length === 0, 'no other call site steps the solver directly',
    `${strays.length} stray ns.step( call(s)`);

  const calls = [...src.matchAll(/\badvanceNS\s*\(/g)];
  ok(calls.length >= 3, 'and both the live loop and the recorder use it',
    `${calls.length} occurrences (1 definition + call sites)`);
}

console.log('\n=== 8. Drawing solids into water ===');
/* Reported as "liquid and when drawing solids still gives a lot of bugs ... it
 * still blows up to super high speed", with a screenshot of a tank shattered
 * into blobs and the legend reading 258 against a ceiling of 182.
 *
 * The cause was not the solver. Drawing a solid destroys the water in those
 * cells — correctly, it is inside a wall now — but `targetVolume` still counted
 * it, so the target became permanently unreachable and `correctVolume` pumped
 * water into every surface cell every step, forever. Mass appearing at the
 * surface under gravity is an energy source. The water was not exploding, it
 * was being inflated. */
{
  const tank = () => {
    const t = makeTank(160, 96);
    t.ns.speedCap = Math.sqrt(9 * 96 * 0.45) * 8;
    t.fs.reset(0.45);
    return t;
  };
  const peak = g => {
    let m = 0;
    for (let i = 0; i < g.size; i++) {
      const q = g.u[i] * g.u[i] + g.v[i] * g.v[i];
      if (q > m) m = q;
    }
    return Math.sqrt(m);
  };

  // A disc drawn into settled water, exactly as the brush does it.
  const t = tank();
  for (let k = 0; k < 150; k++) step(t);
  const { g, fs, ns } = t;
  const s = g.stride;
  for (let j = 1; j <= g.ny; j++)
    for (let i = 1; i <= g.nx; i++)
      if (Math.hypot(i - 55, j - 68) < 13) g.solid[i + j * s] = 1;
  g.refreshSolidFlag(); ns.onGeometryChanged();
  fs.syncGeometry();                     // what app.reraster() does in water mode

  const vAfterDraw = fs.volume();
  let worst = 0;
  for (let k = 0; k < 400; k++) { step(t); const p = peak(g); if (p > worst) worst = p; }
  const grew = (fs.volume() - vAfterDraw) / Math.max(vAfterDraw, 1);
  console.log(`    after drawing: peak |u| ${worst.toFixed(1)} (cap ${ns.speedCap.toFixed(0)}), volume grew ${(grew * 100).toFixed(1)}%`);
  ok(worst < ns.speedCap * 0.5, 'drawing a solid does not drive the flow to the ceiling',
    `${worst.toFixed(1)} of ${ns.speedCap.toFixed(0)}`);
  ok(Math.abs(grew) < 0.03, 'and does not conjure water to refill a stale target',
    `${(grew * 100).toFixed(1)}%`);
}

console.log('\n=== 9. Water sealed away from air is held still ===');
/* Incompressible water in a rigid container with no air in it cannot move —
 * there is no free surface to deform and nowhere for a parcel to go. The solver
 * could not express that: a sealed pocket is all-Neumann and singular, and the
 * moment one cell fell below FULL it was reclassified as air, whose Dirichlet
 * p = 0 pulled its neighbours empty in a cascade. Measured before the fix, all
 * 578 cells of a boxed-in pocket evaporated within fifty steps and the collapse
 * drove the peak speed to the ceiling. */
{
  const t = makeTank(160, 96);
  t.ns.speedCap = Math.sqrt(9 * 96 * 0.45) * 8;
  t.fs.reset(0.45);
  for (let k = 0; k < 150; k++) step(t);
  const { g, fs, ns } = t;
  const s = g.stride;
  // A closed box drawn entirely inside the water.
  for (let i = 40; i < 78; i++)
    for (let d = 0; d < 3; d++) { g.solid[i + (60 + d) * s] = 1; g.solid[i + (80 + d) * s] = 1; }
  for (let j = 60; j < 83; j++)
    for (let d = 0; d < 3; d++) { g.solid[40 + d + j * s] = 1; g.solid[75 + d + j * s] = 1; }
  g.refreshSolidFlag(); ns.onGeometryChanged(); fs.syncGeometry();
  fs.syncAir();

  let sealedCells = 0;
  for (let i = 0; i < g.size; i++) if (fs.sealed[i]) sealedCells++;
  const trapped = () => {
    let v = 0;
    for (let i = 0; i < g.size; i++) if (fs.sealed[i]) v += fs.fill[i];
    return v;
  };
  const v0 = trapped();
  for (let k = 0; k < 300; k++) step(t);
  const v1 = trapped();
  console.log(`    ${sealedCells} sealed cells, trapped volume ${v0.toFixed(0)} -> ${v1.toFixed(0)}`);
  ok(sealedCells > 100, 'the pocket is detected as sealed', String(sealedCells));
  ok(v0 > 0 && Math.abs(v1 - v0) < v0 * 0.02, 'and its water neither drains nor moves',
    `${v0.toFixed(0)} -> ${v1.toFixed(0)}`);
}

console.log('\n=== 10. The speed ceiling is a guarantee, not a target ===');
/* The user's standing requirement: "if you cant fix it you need to have
 * something in place to stop it going to infinite speed."
 *
 * The face clamp bounds each velocity COMPONENT, which leaves the cell-centred
 * reconstruction free to reach cap*sqrt(2) — that is why a tank with a ceiling
 * of 182 put 258 on the legend. Everything downstream reads the mirror, so the
 * mirror is where the guarantee has to live. This drives the field absurdly
 * hard and then checks the published array, which is what the colour scale, the
 * probe, the diagnostics and the particles all read. */
{
  const t = makeTank(96, 64);
  const cap = 12;
  t.ns.speedCap = cap;
  t.fs.reset(0.5);
  const { g, ns, fs } = t;
  let worst = 0, finite = true;
  for (let k = 0; k < 200; k++) {
    // Absurd impulses every step, far beyond anything a brush can do.
    for (let i = 0; i < g.size; i++) { g.fx[i] = (i % 7) * 50 - 150; g.fy[i] = (i % 5) * 60 - 120; }
    step(t);
    for (let i = 0; i < g.size; i++) {
      const m = Math.hypot(g.u[i], g.v[i]);
      if (!Number.isFinite(m)) finite = false;
      if (m > worst) worst = m;
    }
  }
  console.log(`    driven with absurd impulses for 200 steps: peak reported |u| ${worst.toFixed(2)} against a cap of ${cap}`);
  ok(finite, 'the reported field stays finite under any forcing');
  ok(worst <= cap * 1.001, 'and never exceeds the ceiling',
    `${worst.toFixed(2)} > ${cap}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
