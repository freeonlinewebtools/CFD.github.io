/* Orientation: every render path must agree that grid row 1 is the TOP.
 *
 * The three paths use different coordinate systems and had drifted apart:
 *   grid arrays   j = 1 .. ny, increasing downward
 *   Canvas2D      ImageData row 0 is the top
 *   2D overlay    canvas y increases downward
 *   WebGL         clip space y increases UPWARD  <- the one that was wrong
 */
import fs from 'node:fs';

const B = '../src/';
const SRC = 'c:/UBGHyper/HyperClient/CFD.github.io/src/';
const { Grid } = await import(B + 'grid.js');
const { Canvas2DRenderer } = await import(B + 'render-2d.js');
const { Scene, Shapes } = await import(B + 'scene.js');
const { Raster } = await import(B + 'raster.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); } };

/* ── minimal canvas stub that keeps the ImageData we can inspect ── */
function stubCanvas(w, h) {
  const store = {};
  return {
    width: w, height: h,
    getContext: () => ({
      createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
      putImageData: (img) => { store.img = img; },
      drawImage: () => {},
      set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {},
    }),
    _store: store,
  };
}
global.document = { createElement: () => stubCanvas(64, 64) };

console.log('=== 1. Canvas2D puts grid row 1 at the top ===');
{
  const g = new Grid(64, 32);
  // Solid marker in the TOP-LEFT corner of the grid.
  for (let j = 1; j <= 4; j++) for (let i = 1; i <= 4; i++) g.solid[i + j * g.stride] = 1;
  g.refreshSolidFlag();

  const canvas = stubCanvas(64, 32);
  const r = new Canvas2DRenderer(canvas);
  const theme = { bg: [0, 0, 0], body: [1, 1, 1], light: false };
  r.draw(g, { mode: 'speed', stats: { speed: 1, press: 1, curl: 1, grad: 1, q: 1 }, theme, soundSpeed: 1 });

  const img = r.off._store.img || r.img;
  const buf = new Uint32Array(img.data.buffer);
  const at = (x, y) => buf[y * 64 + x];
  const white = 0xffffffff;
  ok(at(1, 1) === white, 'marker at grid (2,2) renders in the TOP-left of the image');
  ok(at(1, 30) !== white, 'bottom-left of the image is NOT the marker');
}

console.log('\n=== 2. WebGL vertex shader maps clip-top to grid row 1 ===');
{
  // WebGL cannot run headless here, so evaluate the shader's own arithmetic.
  // Pull the two lines that decide the mapping straight out of the source so
  // this cannot pass against a shader that no longer contains them.
  const src = fs.readFileSync(SRC + 'render-gl.js', 'utf8');
  const vert = src.slice(src.indexOf('const VERT'), src.indexOf('const FRAG'));

  const uvLine = /vUV\s*=\s*([^;]+);/.exec(vert);
  const posLine = /gl_Position\s*=\s*vec4\(([^;]+)\);/.exec(vert);
  ok(!!uvLine && !!posLine, 'vertex shader assigns vUV and gl_Position');

  const toTexel = /vec2\s+toTexel\(vec2\s+uv\)\s*\{\s*return\s+([^;]+);/.exec(src);
  ok(!!toTexel, 'fragment shader defines toTexel');
  console.log(`    vUV      = ${uvLine[1].trim()}`);
  console.log(`    toTexel  = ${toTexel[1].trim()}`);

  // Reproduce the mapping for the two extremes of the full-screen triangle.
  const flips = /1\.0\s*-\s*p\.y/.test(uvLine[1]);
  const ny = 32;
  const rowFor = clipY => {
    // p.y is 0 at clip -1 (screen BOTTOM) and 1 at clip +1 (screen TOP).
    const pY = (clipY + 1) / 2;
    const uvY = flips ? 1 - pY : pY;
    return 0.5 + uvY * ny;          // toTexel
  };
  const top = rowFor(+1), bottom = rowFor(-1);
  console.log(`    screen top  -> grid row ${top.toFixed(1)}`);
  console.log(`    screen base -> grid row ${bottom.toFixed(1)}`);
  ok(top < bottom, 'screen top maps to a SMALLER grid row than screen bottom', `top=${top} bottom=${bottom}`);
  ok(Math.abs(top - 0.5) < 1e-9, 'screen top is grid row 0.5 (the first interior row)');
  ok(Math.abs(bottom - (ny + 0.5)) < 1e-9, 'screen bottom is grid row ny+0.5');
}

console.log('\n=== 3. The 2D overlay agrees ===');
{
  const src = fs.readFileSync(SRC + 'overlays.js', 'utf8');
  ok(/\(j - 0\.5\) \* sy/.test(src), 'overlay places grid row j at (j-0.5)*sy, so row 1 is near y=0 (top)');
}

console.log('\n=== 4. Drawn geometry lands where it was drawn ===');
{
  // Place an object in the top half of the domain and confirm the rasterised
  // cells are in the top half of the grid — the failure the screenshot showed.
  const scene = new Scene(64, 32);
  scene.add(Shapes.circle(20, 8, 4));           // y = 8 of 32 -> upper quarter
  const r = new Raster(64, 32);
  r.build(scene);

  let sumJ = 0, n = 0;
  for (let j = 1; j <= 32; j++) for (let i = 1; i <= 64; i++) {
    if (r.solid[i + j * r.stride]) { sumJ += j; n++; }
  }
  const centroid = sumJ / n;
  console.log(`    object placed at y=8, raster centroid j=${centroid.toFixed(2)}`);
  ok(n > 0, 'object rasterised');
  ok(Math.abs(centroid - 8) < 1.0, 'raster centroid matches the placed y', `j=${centroid.toFixed(2)}`);
  ok(centroid < 16, 'object is in the TOP half of the grid');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
