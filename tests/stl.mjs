/* STL parsing, slicing and stitching.
 *
 * Built from meshes whose cross-sections are known analytically — a cube slices
 * to a square, a cylinder to a circle of the right area — so a failure says
 * which of the three stages broke rather than "the outline looks wrong".
 */
const { parseSTL, sliceMesh, stitchLoops, sliceToScene, orientPoints, planeAxes }
  = await import('../src/stl.js');
const { Scene, Shapes } = await import('../src/scene.js');
const { Raster } = await import('../src/raster.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => {
  if (c) { pass++; console.log(`  PASS  ${m}`); }
  else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); }
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── mesh builders ────────────────────────────────────────────────────── */

function toBinarySTL(tris) {
  const n = tris.length / 9;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let v = 0; v < 9; v++, o += 4) dv.setFloat32(o, tris[t * 9 + v], true);
    o += 2;
  }
  return buf;
}

/* Axis-aligned box as 12 triangles. */
function boxTris(x0, y0, z0, x1, y1, z1) {
  const p = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],
             [x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],
                 [1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
  const out = [];
  for (const f of faces) for (const i of f) out.push(...p[i]);
  return out;
}

/* Closed cylinder along z, radius r, from z0 to z1. */
function cylinderTris(r, z0, z1, seg = 64) {
  const out = [];
  for (let k = 0; k < seg; k++) {
    const a = (k / seg) * Math.PI * 2, b = ((k + 1) / seg) * Math.PI * 2;
    const x0 = r * Math.cos(a), y0 = r * Math.sin(a);
    const x1 = r * Math.cos(b), y1 = r * Math.sin(b);
    out.push(x0, y0, z0, x1, y1, z0, x1, y1, z1);   // side
    out.push(x0, y0, z0, x1, y1, z1, x0, y0, z1);
    out.push(0, 0, z0, x1, y1, z0, x0, y0, z0);     // caps
    out.push(0, 0, z1, x0, y0, z1, x1, y1, z1);
  }
  return out;
}

const ringArea = pts => {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i += 2) {
    const j = (i + 2) % n;
    s += pts[i] * pts[j + 1] - pts[j] * pts[i + 1];
  }
  return Math.abs(s) / 2;
};

console.log('=== 1. Parsing ===');
{
  const tris = boxTris(-1, -2, -3, 1, 2, 3);
  const bin = parseSTL(toBinarySTL(tris));
  ok(bin.count === 12, 'binary STL: 12 triangles for a box', String(bin.count));
  ok(near(bin.min[0], -1, 1e-6) && near(bin.max[2], 3, 1e-6), 'binary bounds are right',
    JSON.stringify([bin.min, bin.max]));
  ok(near(bin.size[1], 4, 1e-6), 'binary size is max - min');

  let ascii = 'solid test\n';
  for (let t = 0; t < tris.length; t += 9) {
    ascii += 'facet normal 0 0 0\n outer loop\n';
    for (let v = 0; v < 9; v += 3) ascii += `  vertex ${tris[t+v]} ${tris[t+v+1]} ${tris[t+v+2]}\n`;
    ascii += ' endloop\nendfacet\n';
  }
  ascii += 'endsolid test\n';
  const a = parseSTL(ascii);
  ok(a.count === 12, 'ASCII STL: same triangle count');
  ok(near(a.max[1], 2, 1e-6), 'ASCII bounds match the binary ones');

  /* A binary file whose header happens to begin "solid" is the classic way STL
   * readers misdetect. Length arithmetic has to win over the keyword. */
  const tricky = toBinarySTL(tris);
  new Uint8Array(tricky).set([115, 111, 108, 105, 100, 32], 0);   // "solid "
  ok(parseSTL(tricky).count === 12, 'binary file starting with "solid" is not read as ASCII');

  let threw = false;
  try { parseSTL(new ArrayBuffer(10)); } catch { threw = true; }
  ok(threw, 'garbage is refused');
}

console.log('\n=== 2. Slicing a box gives its rectangle ===');
{
  const mesh = parseSTL(toBinarySTL(boxTris(-3, -5, -7, 3, 5, 7)));
  // Cut across z: the section is the x-y rectangle, 6 x 10.
  const loops = stitchLoops(sliceMesh(mesh, 2, 0), 1e-4);
  ok(loops.length === 1, 'one ring', String(loops.length));
  ok(loops[0].closed, 'and it is closed');
  ok(near(ringArea(loops[0].pts), 60, 0.01), 'area is 6 x 10', ringArea(loops[0].pts).toFixed(3));

  // Cut across x: the section is y-z, 10 x 14.
  const l2 = stitchLoops(sliceMesh(mesh, 0, 0), 1e-4);
  ok(near(ringArea(l2[0].pts), 140, 0.01), 'slicing the other axis gives 10 x 14',
    ringArea(l2[0].pts).toFixed(3));

  // Off the end of the model.
  ok(sliceMesh(mesh, 2, 99).length === 0, 'a plane that misses the model yields nothing');
}

console.log('\n=== 3. Slicing a cylinder gives a circle ===');
{
  const mesh = parseSTL(toBinarySTL(cylinderTris(4, -5, 5, 96)));
  const loops = stitchLoops(sliceMesh(mesh, 2, 0), 1e-4);
  ok(loops.length === 1 && loops[0].closed, 'one closed ring');
  const a = ringArea(loops[0].pts);
  // A 96-gon inscribed in r=4 is a hair under pi r^2.
  console.log(`    area ${a.toFixed(3)}, pi r^2 = ${(Math.PI * 16).toFixed(3)}`);
  ok(Math.abs(a - Math.PI * 16) / (Math.PI * 16) < 0.01, 'area within 1% of pi r^2');
  ok(loops[0].pts.length / 2 >= 90, 'the ring keeps its points', String(loops[0].pts.length / 2));
}

console.log('\n=== 4. Two separate bodies stay separate ===');
/* The stitcher must not join rings that merely happen to be adjacent in the
 * triangle list — that would weld two aerofoils into one shape. */
{
  const tris = [...boxTris(-10, -2, -2, -6, 2, 2), ...boxTris(6, -2, -2, 10, 2, 2)];
  const mesh = parseSTL(toBinarySTL(tris));
  const loops = stitchLoops(sliceMesh(mesh, 2, 0), 1e-4);
  ok(loops.length === 2, 'two rings for two boxes', String(loops.length));
  ok(loops.every(l => l.closed), 'both closed');
  ok(loops.every(l => near(ringArea(l.pts), 16, 0.01)), 'each is 4 x 4');
}

console.log('\n=== 5. A hollow section keeps its inner ring ===');
{
  const tris = [...cylinderTris(6, -3, 3, 64), ...cylinderTris(3, -3, 3, 64)];
  const mesh = parseSTL(toBinarySTL(tris));
  const loops = stitchLoops(sliceMesh(mesh, 2, 0), 1e-4);
  ok(loops.length === 2, 'outer and inner rings both found', String(loops.length));
  const areas = loops.map(l => ringArea(l.pts)).sort((a, b) => b - a);
  ok(Math.abs(areas[0] - Math.PI * 36) / (Math.PI * 36) < 0.02, 'outer is r=6');
  ok(Math.abs(areas[1] - Math.PI * 9) / (Math.PI * 9) < 0.02, 'inner is r=3');
}

console.log('\n=== 6. Fitting into the domain ===');
{
  const mesh = parseSTL(toBinarySTL(cylinderTris(50, -20, 20, 64)));
  const { shapes } = sliceToScene(mesh, { axis: 2, position: 0, nx: 256, ny: 128 });
  ok(shapes.length === 1, 'one shape');
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < shapes[0].pts.length; i += 2) {
    minX = Math.min(minX, shapes[0].pts[i]); maxX = Math.max(maxX, shapes[0].pts[i]);
    minY = Math.min(minY, shapes[0].pts[i + 1]); maxY = Math.max(maxY, shapes[0].pts[i + 1]);
  }
  ok(near(maxY - minY, 128 * 0.25, 1.5), 'blockage capped at a quarter of the tunnel',
    (maxY - minY).toFixed(2));
  ok(near((minX + maxX) / 2, 256 * 0.35, 1), 'placed upstream of centre');

  // Units are irrelevant: the same shape in millimetres must land identically.
  const mm = parseSTL(toBinarySTL(cylinderTris(50000, -20000, 20000, 64)));
  const b = sliceToScene(mm, { axis: 2, position: 0, nx: 256, ny: 128 }).shapes[0];
  let h2 = -Infinity, l2 = Infinity;
  for (let i = 1; i < b.pts.length; i += 2) { h2 = Math.max(h2, b.pts[i]); l2 = Math.min(l2, b.pts[i]); }
  ok(near(h2 - l2, maxY - minY, 0.5), 'model units do not change the result',
    `${(h2 - l2).toFixed(2)} vs ${(maxY - minY).toFixed(2)}`);
}

console.log('\n=== 7. It reaches the solver as real geometry ===');
{
  const mesh = parseSTL(toBinarySTL(cylinderTris(10, -5, 5, 96)));
  const { shapes } = sliceToScene(mesh, { axis: 2, position: 0, nx: 200, ny: 200 });
  const scene = new Scene(200, 200);
  scene.add(Shapes.polygonAbs(shapes[0].pts, { name: 'slice' }));
  const r = new Raster(200, 200);
  r.build(scene);
  const st = r.stats();
  const expect = Math.PI * 25 * 25;            // blockage cap -> d = 50
  console.log(`    solid=${st.solid} cells, analytic=${expect.toFixed(0)}`);
  ok(Math.abs(st.solid - expect) / expect < 0.06, 'sliced circle rasterises to the right area',
    `${st.solid} vs ${expect.toFixed(0)}`);
  ok(st.partial > 20, 'and carries a fractional rim for the force integral');
}

console.log('\n=== 8. Bad input is refused clearly ===');
{
  const mesh = parseSTL(toBinarySTL(boxTris(-1, -1, -1, 1, 1, 1)));
  let threw = false;
  try { sliceToScene(mesh, { axis: 2, position: 50, nx: 128, ny: 64 }); } catch (e) {
    threw = /misses the model/.test(e.message);
  }
  ok(threw, 'a plane outside the model says so');
}

console.log('\n=== 9. Orientation ===');
/* Which way a slice comes out depends on which two axes the cut leaves and
 * their handedness, so a section can face upstream on one axis and downstream
 * on another. These check the flip actually flips — a control that silently
 * does nothing is worse than no control at all. */
{
  // Asymmetric points, so a mirror is detectable; a symmetric shape would pass
  // a completely broken flip.
  ok(orientPoints([0, 0, 3, 0, 1, 0], { flipX: true }).join() === '0,0,-3,0,-1,0',
    'flip H negates x');
  ok(orientPoints([0, 1, 2, 5], { flipY: true }).join() === '0,-1,2,-5', 'flip V negates y');
  ok(orientPoints([0, 0, 1, 0], {}).join() === '0,0,1,0', 'no orientation is a no-op');

  // A quarter turn clockwise on screen (y down) sends +x to +y.
  const q = orientPoints([1, 0], { turns: 1 });
  ok(near(q[0], 0, 1e-9) && near(q[1], 1, 1e-9), 'one turn sends +x to +y', q.join());
  const four = orientPoints([2, 5], { turns: 4 });
  ok(near(four[0], 2, 1e-9) && near(four[1], 5, 1e-9), 'four turns is the identity');

  // Flip then turn must compose in that order, not the reverse.
  const c = orientPoints([1, 0], { flipX: true, turns: 1 });
  ok(near(c[0], 0, 1e-9) && near(c[1], -1, 1e-9), 'flip is applied before the turn', c.join());

  ok(planeAxes(2).cut === 'Z' && planeAxes(2).across === 'X', 'Z cut leaves X across');
  ok(planeAxes(0).cut === 'X' && planeAxes(0).across === 'Y', 'X cut leaves Y across');
}

console.log('\n=== 10. Orientation reaches the fitted result ===');
/* A quarter turn has to be applied BEFORE fitting, or a long shape is sized by
 * its old bounding box and then rotated out of the tunnel. */
{
  const mesh = parseSTL(toBinarySTL(boxTris(-40, -5, -2, 40, 5, 2)));   // long in x
  const span = sh => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < sh.pts.length; i += 2) {
      a = Math.min(a, sh.pts[i]); c = Math.max(c, sh.pts[i]);
      b = Math.min(b, sh.pts[i + 1]); d = Math.max(d, sh.pts[i + 1]);
    }
    return { w: c - a, h: d - b };
  };
  const flat = span(sliceToScene(mesh, { axis: 2, position: 0, nx: 256, ny: 128 }).shapes[0]);
  ok(flat.w > flat.h, 'the long box is wide before turning',
    `${flat.w.toFixed(1)} x ${flat.h.toFixed(1)}`);

  const turned = span(sliceToScene(mesh, { axis: 2, position: 0, nx: 256, ny: 128,
                                           orient: { turns: 1 } }).shapes[0]);
  ok(turned.h > turned.w, 'and tall after a quarter turn',
    `${turned.w.toFixed(1)} x ${turned.h.toFixed(1)}`);
  ok(turned.h <= 128 * 0.26, 'the turned shape is re-checked against the blockage cap',
    `${turned.h.toFixed(1)} of 128`);

  // A flip changes which way it faces, never how big it is.
  const mirrored = span(sliceToScene(mesh, { axis: 2, position: 0, nx: 256, ny: 128,
                                             orient: { flipX: true } }).shapes[0]);
  ok(near(mirrored.w, flat.w, 1e-6) && near(mirrored.h, flat.h, 1e-6),
    'a flip preserves the fitted size');

  /* And the flip must survive into the fitted output rather than being lost
   * somewhere between slicing and placing. A wedge is asymmetric about its own
   * centre, so mirroring moves its centroid relative to its bounding box. */
  const wedge = parseSTL(toBinarySTL([
    ...boxTris(-30, -8, -1, -10, 8, 1), ...boxTris(-10, -2, -1, 30, 2, 1),
  ]));
  const off = o => {
    const sh = sliceToScene(wedge, { axis: 2, position: 0, nx: 256, ny: 128, orient: o }).shapes;
    let a = Infinity, c = -Infinity, sum = 0, n = 0;
    for (const s of sh) for (let i = 0; i < s.pts.length; i += 2) {
      a = Math.min(a, s.pts[i]); c = Math.max(c, s.pts[i]); sum += s.pts[i]; n++;
    }
    return (sum / n - (a + c) / 2);        // centroid offset within the bbox
  };
  const plain = off(null), flipped = off({ flipX: true });
  ok(Math.abs(plain) > 0.5, 'the test wedge is genuinely asymmetric', plain.toFixed(2));
  ok(near(flipped, -plain, 0.05), 'flipping mirrors it in the fitted output',
    `${plain.toFixed(2)} -> ${flipped.toFixed(2)}`);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
