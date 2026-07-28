/* Coverage-weighted force integration (item 15).
 *
 * These tests use ANALYTIC pressure and velocity fields rather than a running
 * flow, so the answers are known exactly and the integral is tested on its own
 * — separately from whatever the solver happens to produce. The properties
 * checked are the ones the staircase surface got wrong:
 *
 *   - a uniform pressure gradient must lift a body by its own AREA (buoyancy),
 *   - the wetted length must be pi*D, not the staircase's 4D,
 *   - and neither may drift when the mesh is refined, which is the failure the
 *     force coefficients showed before this change.
 */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { Diagnostics } = await import(B + 'diagnostics.js');
const { Scene, Shapes } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? '  <- ' + detail : ''}`); }
};

/* A grid holding one body, built through the real scene -> raster pipeline. */
function body(nx, ny, make) {
  const g = new Grid(nx, ny);
  const scene = new Scene(nx, ny);
  scene.add(make(nx, ny));
  const r = new Raster(nx, ny);
  r.build(scene);
  r.applyTo(g, 1);
  return { g, r, d: new Diagnostics(g) };
}
const circle = D => (nx, ny) => Shapes.circle(nx * 0.5, (ny + 1) / 2, D / 2);
const square = W => (nx, ny) => Shapes.rect(Math.round(nx * 0.5), Math.round((ny + 1) / 2), W, W);

/* forces() reports coefficients; recover the raw force it integrated. */
function rawForce(ctx, { visc = 0, dt = 1, uRef = 1 } = {}) {
  const { g, d } = ctx;
  d.forces(uRef, visc, dt);
  const b = d.bounds;
  const q = 0.5 * uRef * uRef * Math.max(1, b.height, b.width);
  return { fx: d.cd * q, fy: -d.cl * q, b };
}

/* Sum of the fractional coverage = the body's supersampled area. */
const covArea = r => { let a = 0; for (let i = 0; i < r.coverage.length; i++) a += r.coverage[i]; return a; };

/* Impose p = -x. The surface integral -closed-int p*n dS then reduces exactly
 * to the enclosed area — Archimedes — which makes the body's own area the
 * analytic answer to compare against. */
const linearP = g => {
  for (let j = 0; j <= g.ny + 1; j++)
    for (let i = 0; i <= g.nx + 1; i++) g.p[i + j * g.stride] = -i;
};

console.log('=== 1. The surface integral itself is exact ===');
/* Two error sources are in play and they are worth separating: the smeared
 * surface, and the wall pressure that has to be invented inside the body.
 * Handing forces() a pressure field that is already valid inside the solid
 * removes the second and measures the first on its own. */
{
  for (const D of [12, 16, 24, 32, 48, 64]) {
    const ctx = body(8 * D, 4 * D, circle(D));
    const { g, d } = ctx;
    linearP(g);
    d._extendWallPressure = () => g.p;      // analytic p is valid inside too
    const { fx } = rawForce(ctx);
    const exact = Math.PI * D * D / 4;
    const err = Math.abs(fx - exact) / exact;
    console.log(`    D=${D}  Fx=${fx.toFixed(1)}  analytic area=${exact.toFixed(1)}  coverage area=${covArea(ctx.r).toFixed(1)}  err=${(err * 100).toFixed(2)}%`);
    ok(err < 0.01, `D=${D}: buoyancy force equals the body area within 1%`, `${(err * 100).toFixed(2)}%`);
  }
}

console.log('\n=== 2. The full path converges as the mesh is refined ===');
/* This is the property the staircase surface lacked, and the reason the force
 * coefficients moved AWAY from the reference when the mesh was refined: the
 * staircase perimeter converges to 4/pi times the real one, so its error tends
 * to 27%, not to zero. Here the remaining error is the mirrored wall pressure
 * — p is extended into the solid assuming dp/dn = 0, which a uniform pressure
 * gradient deliberately violates — and it must shrink with resolution. */
{
  const Ds = [12, 16, 24, 32, 48, 64], errs = [];
  for (const D of Ds) {
    const ctx = body(8 * D, 4 * D, circle(D));
    linearP(ctx.g);
    errs.push(Math.abs(rawForce(ctx).fx / (Math.PI * D * D / 4) - 1));
  }
  console.log(`    D:     ${Ds.map(d => String(d).padStart(6)).join('')}`);
  console.log(`    error: ${errs.map(e => (e * 100).toFixed(2).padStart(5) + '%').join('')}`);
  // Staircase, for contrast: 35% at D=8 falling only to 28% at D=64.
  ok(errs[errs.length - 1] < errs[0] * 0.6, 'the error more than halves from D=12 to D=64',
    `${(errs[0] * 100).toFixed(2)}% -> ${(errs[errs.length - 1] * 100).toFixed(2)}%`);
  let monotone = true;
  for (let i = 1; i < errs.length; i++) if (errs[i] > errs[i - 1] + 0.004) monotone = false;
  ok(monotone, 'and it decreases monotonically with refinement');
  ok(errs[errs.length - 1] < 0.02, 'reaching under 2% at D=64', `${(errs[errs.length - 1] * 100).toFixed(2)}%`);
}

console.log('\n=== 3. Wetted length is the circle, not the staircase ===');
/* Uniform unit velocity makes the friction sum proportional to wetted length,
 * so the reported force divides out to a perimeter. The staircase measures
 * 4D (= 1.27 pi D) and drifts; the coverage surface must measure pi*D. */
{
  for (const D of [16, 32]) {
    const ctx = body(8 * D, 4 * D, circle(D));
    const { g } = ctx;
    g.u.fill(1); g.v.fill(0); g.p.fill(0);
    const visc = 0.25;
    const { fx } = rawForce(ctx, { visc });
    // friction contribution is 2*visc*u per unit wetted length, u = 1
    const wetted = fx / (2 * visc);
    const exact = Math.PI * D;
    const err = Math.abs(wetted - exact) / exact;
    console.log(`    D=${D}  wetted=${wetted.toFixed(2)}  pi*D=${exact.toFixed(2)}  staircase would be ~${(4 * D).toFixed(0)}  err=${(err * 100).toFixed(2)}%`);
    ok(err < 0.06, `D=${D}: wetted length matches pi*D within 6%`, `${(err * 100).toFixed(2)}%`);
  }
}

console.log('\n=== 4. Axis-aligned bodies are unaffected ===');
/* A square has no staircase error to remove, so the correction must be inert
 * there — a guard against the weighting quietly rescaling everything. */
{
  const W = 20;
  const ctx = body(160, 80, square(W));
  const { g } = ctx;
  g.u.fill(1); g.v.fill(0); g.p.fill(0);
  const visc = 0.25;
  const { fx } = rawForce(ctx, { visc });
  const wetted = fx / (2 * visc);
  const err = Math.abs(wetted - 4 * W) / (4 * W);
  console.log(`    ${W}x${W} square: wetted=${wetted.toFixed(2)}  perimeter=${4 * W}  err=${(err * 100).toFixed(2)}%`);
  ok(err < 0.06, 'square wetted length equals its true perimeter within 6%', `${(err * 100).toFixed(2)}%`);
}

console.log('\n=== 5. The reference length is the body, not its bounding box ===');
/* L divides every coefficient. A bounding box counts CELLS, so a circle of
 * diameter D measures D+1 — an error that shrinks as 1/D and therefore mimics
 * convergence. The coverage silhouette must return D itself. */
{
  for (const D of [8, 16, 24, 48]) {
    const ctx = body(8 * D, 4 * D, circle(D));
    ctx.d.bodyBounds();
    const L = Math.max(ctx.d.bounds.height, ctx.d.bounds.width);
    const err = Math.abs(L - D) / D;
    console.log(`    D=${D}  L=${L.toFixed(3)}  bounding box would be ${D + 1}  err=${(err * 100).toFixed(2)}%`);
    ok(err < 0.01, `D=${D}: reference length is the diameter within 1%`, `${L.toFixed(3)} vs ${D}`);
  }
  // Not square: the extents must not be transposed. |dX/dx| totals 2 per ROW
  // it crosses, so it measures the extent in Y.
  const W = 40, H = 12;
  const ctx = body(240, 120, (nx, ny) => Shapes.rect(Math.round(nx * 0.5), Math.round((ny + 1) / 2), W, H));
  ctx.d.bodyBounds();
  const { height, width } = ctx.d.bounds;
  console.log(`    ${W}x${H} rect: width=${width.toFixed(2)} (want ${W}), height=${height.toFixed(2)} (want ${H})`);
  ok(Math.abs(width - W) / W < 0.03 && Math.abs(height - H) / H < 0.03,
    'a non-square body reports its extents the right way round');
}

console.log('\n=== 6. The pressure datum cannot affect the force ===');
/* The projection removes a mean per connected region, so the absolute level of
 * p is arbitrary. A force that moved with it would be reporting the gauge. */
{
  const ctx = body(256, 128, circle(24));
  const { g } = ctx;
  for (let j = 0; j <= g.ny + 1; j++)
    for (let i = 0; i <= g.nx + 1; i++) g.p[i + j * g.stride] = -i;
  const a = rawForce(ctx);
  for (let i = 0; i < g.p.length; i++) g.p[i] += 1e4;
  const b = rawForce(ctx);
  const drift = Math.abs(a.fx - b.fx) / Math.abs(a.fx);
  console.log(`    Fx = ${a.fx.toFixed(3)} then ${b.fx.toFixed(3)} after adding 1e4 to p`);
  ok(drift < 1e-3, 'adding a constant to p leaves the force unchanged', `drift ${(drift * 100).toExponential(2)}%`);
}

console.log('\n=== 7. Symmetry: no lift on a symmetric body in symmetric flow ===');
{
  const ctx = body(256, 128, circle(24));
  const { g } = ctx;
  for (let j = 0; j <= g.ny + 1; j++)
    for (let i = 0; i <= g.nx + 1; i++) g.p[i + j * g.stride] = -i;
  g.u.fill(1); g.v.fill(0);
  const { fx, fy } = rawForce(ctx, { visc: 0.1 });
  console.log(`    Fx=${fx.toFixed(3)}  Fy=${fy.toExponential(2)}`);
  ok(Math.abs(fy) < Math.abs(fx) * 1e-3, 'lift vanishes on a symmetric configuration');
  ok(fx > 0, 'a downstream pressure gradient produces positive drag');
}

console.log('\n=== 8. Falls back cleanly with no rasteriser behind the grid ===');
/* orient.mjs and any caller that paints `solid` directly must keep working. */
{
  const g = new Grid(64, 64);
  const d = new Diagnostics(g);
  for (let j = 20; j <= 40; j++) for (let i = 20; i <= 40; i++) g.solid[i + j * g.stride] = 1;
  g.refreshSolidFlag();
  for (let j = 0; j <= g.ny + 1; j++)
    for (let i = 0; i <= g.nx + 1; i++) g.p[i + j * g.stride] = -i;
  ok(!g.hasCoverage, 'a hand-painted mask reports no coverage');
  d.forces(1, 0, 1);
  const q = 0.5 * Math.max(1, d.bounds.height, d.bounds.width);
  const fx = d.cd * q;
  console.log(`    hand-painted 21x21 block: Fx=${fx.toFixed(1)}, area=${21 * 21}`);
  ok(Number.isFinite(fx) && fx > 0, 'the staircase fallback still produces a finite positive drag');
  ok(Math.abs(fx - 441) / 441 < 0.15, 'and it is the right magnitude', `${fx.toFixed(1)} vs 441`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
