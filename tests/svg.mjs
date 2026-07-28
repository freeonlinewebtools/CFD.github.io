/* SVG import.
 *
 * Geometry is asserted against shapes whose answer is known analytically —
 * a circle drawn four different ways must import as the same circle — rather
 * than against a golden file, so a failure says which construct broke.
 */
const { importSVG, extractSubpaths, flattenPath, parseTransform } = await import('../src/svg.js');
const { Scene, Shapes } = await import('../src/scene.js');
const { Raster } = await import('../src/raster.js');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? '  <- ' + detail : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const bbox = pts => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    a = Math.min(a, pts[i]); c = Math.max(c, pts[i]);
    b = Math.min(b, pts[i + 1]); d = Math.max(d, pts[i + 1]);
  }
  return { w: c - a, h: d - b, minX: a, minY: b, maxX: c, maxY: d };
};
const area = pts => {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(s) / 2;
};
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

console.log('=== 1. Primitive elements ===');
{
  const s = extractSubpaths(svg('<rect x="10" y="20" width="30" height="40"/>'));
  ok(s.length === 1, 'a rect yields one subpath');
  const b = bbox(s[0].pts);
  ok(near(b.minX, 10, 1e-9) && near(b.minY, 20, 1e-9) && near(b.w, 30, 1e-9) && near(b.h, 40, 1e-9),
    'rect keeps its position and size', JSON.stringify(b));
  ok(s[0].closed, 'rect is closed');

  const c = extractSubpaths(svg('<circle cx="50" cy="50" r="25"/>'));
  ok(near(area(c[0].pts), Math.PI * 625, Math.PI * 625 * 0.01), 'circle area within 1% of pi r^2',
    area(c[0].pts).toFixed(1));

  const e = extractSubpaths(svg('<ellipse cx="0" cy="0" rx="30" ry="10"/>'));
  ok(near(area(e[0].pts), Math.PI * 300, Math.PI * 300 * 0.01), 'ellipse area within 1%');

  const p = extractSubpaths(svg('<polygon points="0,0 10,0 10,10 0,10"/>'));
  ok(near(area(p[0].pts), 100, 1e-6) && p[0].closed, 'polygon is closed with the right area');

  const pl = extractSubpaths(svg('<polyline points="0,0 10,0 10,10" fill="none" stroke="#000"/>'));
  ok(pl.length === 1 && !pl[0].closed, 'polyline stays open');
}

console.log('\n=== 2. Path commands ===');
{
  // The same square by absolute, relative, and H/V shorthand.
  const forms = {
    absolute: 'M 0 0 L 40 0 L 40 40 L 0 40 Z',
    relative: 'm 0 0 l 40 0 l 0 40 l -40 0 z',
    shorthand: 'M 0 0 H 40 V 40 H 0 Z',
    implicitLineto: 'M 0 0 40 0 40 40 0 40 Z',
  };
  for (const [name, d] of Object.entries(forms)) {
    const sp = flattenPath(d);
    ok(sp.length === 1 && sp[0].closed && near(area(sp[0].pts), 1600, 1e-6),
      `${name} path is a 40x40 square`, `area=${sp.length ? area(sp[0].pts).toFixed(2) : 'none'}`);
  }

  // A circle from four arcs, and from four cubics, must agree.
  const arc = flattenPath('M 50 25 A 25 25 0 1 1 49.99 25 Z')[0];
  ok(near(area(arc.pts), Math.PI * 625, Math.PI * 625 * 0.02), 'arc circle within 2% of pi r^2',
    area(arc.pts).toFixed(1));

  const k = 0.5522847 * 25;
  const cub = flattenPath(
    `M 25 50 C 25 ${50 - k} ${50 - k} 25 50 25 C ${50 + k} 25 75 ${50 - k} 75 50 ` +
    `C 75 ${50 + k} ${50 + k} 75 50 75 C ${50 - k} 75 25 ${50 + k} 25 50 Z`)[0];
  ok(near(area(cub.pts), Math.PI * 625, Math.PI * 625 * 0.01), 'bezier circle within 1% of pi r^2',
    area(cub.pts).toFixed(1));

  // S and T must reflect the previous control point.
  const s1 = flattenPath('M 0 0 C 10 -20 30 -20 40 0 S 70 20 80 0');
  ok(s1.length === 1 && s1[0].pts.length > 40, 'S continues a cubic run');
  const t1 = flattenPath('M 0 0 Q 20 -30 40 0 T 80 0');
  ok(t1.length === 1 && t1[0].pts.length > 40, 'T continues a quadratic run');

  // Multiple subpaths in one d.
  const two = flattenPath('M 0 0 H 10 V 10 H 0 Z M 20 20 H 30 V 30 H 20 Z');
  ok(two.length === 2 && two.every(s => s.closed), 'two subpaths in one path element');
}

console.log('\n=== 3. Transforms ===');
{
  const m = parseTransform('translate(10,20)');
  ok(m[4] === 10 && m[5] === 20, 'translate');
  const s = parseTransform('scale(2)');
  ok(s[0] === 2 && s[3] === 2, 'uniform scale applies to both axes');

  // rotate(90) about the origin sends (1,0) to (0,1).
  const r = parseTransform('rotate(90)');
  ok(near(r[0], 0, 1e-9) && near(r[1], 1, 1e-9), 'rotate about the origin');

  // rotate(180 50 50) about a centre maps (50,50) to itself.
  const rc = parseTransform('rotate(180 50 50)');
  const x = rc[0] * 50 + rc[2] * 50 + rc[4], y = rc[1] * 50 + rc[3] * 50 + rc[5];
  ok(near(x, 50, 1e-6) && near(y, 50, 1e-6), 'rotate about a centre fixes that centre');

  // Nested <g> transforms must compose, and Illustrator emits these constantly.
  const nested = extractSubpaths(svg(
    '<g transform="translate(100,0)"><g transform="scale(2)">' +
    '<rect x="0" y="0" width="10" height="10"/></g></g>'));
  const b = bbox(nested[0].pts);
  ok(near(b.minX, 100, 1e-6) && near(b.w, 20, 1e-6) && near(b.h, 20, 1e-6),
    'nested g transforms compose in the right order', JSON.stringify(b));

  // A closing </g> must pop, so a later sibling is not still translated.
  const sibling = extractSubpaths(svg(
    '<g transform="translate(100,0)"><rect x="0" y="0" width="5" height="5"/></g>' +
    '<rect x="0" y="0" width="5" height="5"/>'));
  ok(sibling.length === 2, 'both siblings found');
  ok(near(bbox(sibling[0].pts).minX, 100, 1e-6) && near(bbox(sibling[1].pts).minX, 0, 1e-6),
    'the transform stack pops at </g>');
}

console.log('\n=== 4. Fitting into the domain ===');
/* Sizing is a blockage decision. Filling the tunnel would look correct and
 * produce meaningless coefficients, so a tall shape is capped at a quarter of
 * the domain height and a long one at just under half its length. */
{
  const { shapes, scale } = importSVG(svg('<circle cx="50" cy="50" r="50"/>'), { nx: 256, ny: 128 });
  ok(shapes.length === 1, 'one shape imported');
  const b = bbox(shapes[0].pts);
  ok(near(b.h, 128 * 0.25, 1), 'a round body is capped by blockage, not by the margin',
    `h=${b.h.toFixed(2)}, want ${(128 * 0.25).toFixed(1)}`);
  ok(b.h / 128 <= 0.26, 'blockage stays at or under a quarter of the tunnel',
    `${(100 * b.h / 128).toFixed(1)}%`);
  ok(near((b.minX + b.maxX) / 2, 256 * 0.35, 0.5), 'placed upstream, leaving room for a wake',
    `${((b.minX + b.maxX) / 2).toFixed(2)}`);
  ok(near((b.minY + b.maxY) / 2, 64, 0.5), 'centred across the flow', `${((b.minY + b.maxY) / 2).toFixed(2)}`);
  ok(scale > 0, 'a positive scale is reported');

  // A long thin shape is limited by length instead.
  const longThin = importSVG(svg('<rect x="0" y="0" width="400" height="20"/>'), { nx: 256, ny: 128 });
  const lb = bbox(longThin.shapes[0].pts);
  ok(near(lb.w, 256 * 0.45, 1), 'a long body is capped by streamwise extent', `w=${lb.w.toFixed(2)}`);

  // Aspect ratio must survive: a wide drawing stays wide.
  const wide = importSVG(svg('<rect x="0" y="0" width="100" height="25"/>'), { nx: 256, ny: 128 });
  const wb = bbox(wide.shapes[0].pts);
  ok(near(wb.w / wb.h, 4, 0.05), 'aspect ratio is preserved', `${(wb.w / wb.h).toFixed(3)}`);

  // y is NOT flipped: SVG y-down matches the grid's j-down.
  const marker = importSVG(svg(
    '<rect x="0" y="0" width="100" height="10"/><rect x="0" y="90" width="100" height="10"/>'),
    { nx: 256, ny: 128 });
  const tops = marker.shapes.map(s => bbox(s.pts).minY).sort((a, b) => a - b);
  ok(tops.length === 2 && tops[0] < tops[1], 'the SVG-top bar stays at the grid top (no y flip)');
}

console.log('\n=== 5. It reaches the solver as real geometry ===');
/* The end-to-end point: an imported outline must rasterise to solid cells. */
{
  const { shapes } = importSVG(svg('<circle cx="50" cy="50" r="50"/>'), { nx: 200, ny: 200 });
  const scene = new Scene(200, 200);
  scene.add(Shapes.polygonAbs(shapes[0].pts, { name: 'imported' }));
  const r = new Raster(200, 200);
  r.build(scene);
  const st = r.stats();
  // blockage cap binds: diameter = 200 * 0.25 = 50, so radius 25
  const expect = Math.PI * 25 * 25;
  console.log(`    solid=${st.solid} cells, analytic=${expect.toFixed(0)}`);
  ok(Math.abs(st.solid - expect) / expect < 0.05, 'imported circle rasterises to the right area',
    `${st.solid} vs ${expect.toFixed(0)}`);
  ok(st.partial > 20, 'and carries a fractional rim for the force integral');
}

console.log('\n=== 6. Bad input is refused clearly ===');
{
  const throws = (fn, what) => {
    try { fn(); ok(false, what); } catch (e) { ok(true, `${what} (${e.message.slice(0, 44)}…)`); }
  };
  throws(() => importSVG('hello', { nx: 128, ny: 64 }), 'non-SVG text is rejected');
  throws(() => importSVG(svg(''), { nx: 128, ny: 64 }), 'an empty SVG is rejected');
  throws(() => importSVG(svg('<text x="0" y="0">hi</text>'), { nx: 128, ny: 64 }),
    'text-only SVG is rejected with advice');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
