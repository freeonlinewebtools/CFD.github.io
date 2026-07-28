/* Where and what actually diverges in the sealed cavity? */
const B = '../src/';
const { Grid } = await import(B + 'grid.js');
const { NavierStokes } = await import(B + 'ns.js');
const { Scene, Shapes } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');
const { PALETTE } = await import(B + 'colormaps.js');

const nx = 256, ny = 128;
const g = new Grid(nx, ny);
const ns = new NavierStokes(g);
ns.windTunnel = false; g.openX = false; ns.inletSpeed = 2.4; ns.visc = 0.05;
ns.speedCap = 2.4 * 25; ns.vorticity = 0; ns.les = false;

const w = Math.max(3, ny * 0.04);
const x0 = nx * 0.5 - ny * 0.44, x1 = nx * 0.5 + ny * 0.44;
const cx = (x0 + x1) / 2, span = x1 - x0;
const scene = new Scene(nx, ny);
for (const o of [
  Shapes.rect(cx, ny - w / 2, span, w), Shapes.rect(x0 + w / 2, ny / 2, w, ny),
  Shapes.rect(x1 - w / 2, ny / 2, w, ny), Shapes.rect(cx, w / 2, span, w),
]) scene.add(o);
const r = new Raster(nx, ny);
r.build(scene);
r.applyTo(g, 2.4);
ns.onGeometryChanged();

const s = g.stride;
const inlets = Array.from({ length: 5 }, (_, k) => ({
  i: Math.round(x0 + w + (span - 2 * w) * (k + 0.5) / 5), j: Math.round(w + 3),
  radius: Math.max(2, Math.round(w * 0.9)),
}));

const where = a => {
  let m = 0, at = -1;
  for (let i = 0; i < a.length; i++) { const x = Math.abs(a[i]); if (Number.isFinite(x) && x > m) { m = x; at = i; } }
  return { m, i: at % s, j: (at / s) | 0, solid: at >= 0 ? g.solid[at] : -1 };
};

console.log('frame  |u|max  at(i,j)  solid?   |p|max  at(i,j)   |div|max at(i,j)   regions');
console.log('       (a cell flagged solid means the blow-up is INSIDE a body)');
for (let f = 1; f <= 34; f++) {
  for (const src of inlets) {
    const rr = src.radius, rate = 0.5, tx = 1.1 * 2.4;
    for (let dj = -rr; dj <= rr; dj++) for (let di = -rr; di <= rr; di++) {
      if (di * di + dj * dj > rr * rr) continue;
      const i = src.i + di, j = src.j + dj;
      if (i < 1 || i > nx || j < 1 || j > ny) continue;
      const idx = i + j * s;
      if (g.solid[idx]) continue;
      const a = (1 - Math.hypot(di, dj) / (rr + 1)) * rate;
      g.fx[idx] += (tx - g.u[idx]) * a;
      g.fy[idx] += (0 - g.v[idx]) * a;
    }
  }
  const uMax = ns.measureMaxSpeed();
  let dt = uMax > 1e-6 ? 1 / uMax : 0.4;
  dt = Math.min(0.4, Math.max(1e-4, dt));
  ns.step(dt, PALETTE);

  const U = where(g.u), P = where(g.p), D = where(g.div);
  if (f <= 6 || f % 4 === 0 || U.m > 1e3) {
    console.log(`${String(f).padStart(4)}  ${U.m.toExponential(2)} (${U.i},${U.j}) s=${U.solid}   ${P.m.toExponential(2)} (${P.i},${P.j})   ${D.m.toExponential(2)} (${D.i},${D.j})   ${ns.poisson.regionCount}`);
  }
  if (U.m > 1e4) break;
}

// Which region is the runaway cell in, and does that region reach an outlet?
const U = where(g.u);
const reg = ns.poisson.region;
console.log(`\nrunaway at (${U.i},${U.j}) is in region ${reg[U.i + U.j * s]} of ${ns.poisson.regionCount}`);
let sizes = {};
for (let i = 0; i < reg.length; i++) if (reg[i] >= 0) sizes[reg[i]] = (sizes[reg[i]] || 0) + 1;
console.log('region sizes:', JSON.stringify(sizes));
