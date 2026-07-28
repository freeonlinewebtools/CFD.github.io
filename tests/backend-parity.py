"""Does the WebGPU backend draw the same picture as WebGL 2?

Two renderers that drift apart become two products, and this app has already
shipped one orientation bug that only one backend had. So rather than checking
that WebGPU "works", this renders the SAME grid state through both and compares
the pixels — including the y-orientation, which is the failure mode with the
most history here.

A small mismatch is expected: the two APIs differ in canvas colour space
handling and the shaders are compiled by different toolchains. A FLIPPED image,
or a wrong colour map, shows up as a large one.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/backend-parity.py [port]
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"
W, H = 320, 160

SCRIPT = """
async ({w, h, backend}) => {
  const { Grid } = await import('/src/grid.js');
  const { NavierStokes } = await import('/src/ns.js');
  const { Scene, Shapes } = await import('/src/scene.js');
  const { Raster } = await import('/src/raster.js');
  const { PALETTE } = await import('/src/colormaps.js');
  const { GLRenderer } = await import('/src/render-gl.js');
  const { GPURenderer } = await import('/src/render-gpu.js');

  // A deliberately ASYMMETRIC state: a symmetric one hides a y-flip entirely,
  // which is exactly how the original orientation bug survived.
  const nx = 128, ny = 64, U = 2.4;
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = U; ns.visc = 0.02;
  ns.speedCap = U * 25;
  const scene = new Scene(nx, ny);
  scene.add(Shapes.circle(nx * 0.3, ny * 0.34, 7));     // off-centre in y
  const r = new Raster(nx, ny); r.build(scene); r.applyTo(g, U);
  ns.onGeometryChanged(); ns.seedFreestream();
  for (let i = 0; i < 220; i++) ns.step(0.2, PALETTE);

  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  document.body.appendChild(cv);

  const rend = backend === 'webgpu'
    ? await GPURenderer.create(cv)
    : GLRenderer.create(cv);
  if (!rend) return { ok: false, why: backend + ' unavailable' };

  const theme = { bg: [0.114, 0.114, 0.114], body: [0.58, 0.59, 0.60], light: false };
  const stats = { speed: 6, press: 0.5, curl: 0.5, grad: 0.05, q: 0.05 };

  const out = {};
  for (const mode of ['speed', 'pressure', 'vorticity', 'qcriterion']) {
    rend.resize(w, h);
    rend.markGeometryDirty();
    rend.draw(g, { mode, stats, theme, dyeOverlay: false, soundSpeed: 1 });
    // Read back in the SAME task as the draw: a WebGPU canvas is only
    // guaranteed readable before the frame is presented.
    const probe = document.createElement('canvas');
    probe.width = w; probe.height = h;
    const pctx = probe.getContext('2d');
    pctx.drawImage(cv, 0, 0);
    const px = pctx.getImageData(0, 0, w, h).data;
    // Downsample to a coarse signature so compiler-level colour differences do
    // not swamp the comparison, but geometry still shows.
    const GX = 16, GY = 8, sig = [];
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      const x0 = Math.floor(gx * w / GX), x1 = Math.floor((gx + 1) * w / GX);
      const y0 = Math.floor(gy * h / GY), y1 = Math.floor((gy + 1) * h / GY);
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const o = (y * w + x) * 4;
        sr += px[o]; sg += px[o + 1]; sb += px[o + 2]; n++;
      }
      sig.push([Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)]);
    }
    out[mode] = sig;
  }
  return { ok: true, backend: rend.backend, sigs: out };
}
"""

def compare(a, b):
    """Mean absolute per-channel difference, and the same after a vertical flip."""
    GX, GY = 16, 8
    def mad(p, q):
        return sum(abs(p[i][c] - q[i][c]) for i in range(len(p)) for c in range(3)) / (len(p) * 3)
    flipped = []
    for gy in range(GY - 1, -1, -1):
        flipped.extend(b[gy * GX:(gy + 1) * GX])
    return mad(a, b), mad(a, flipped)

async def main():
    results = {}
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
        for backend in ("webgl2", "webgpu"):
            page = await b.new_page()
            await page.goto(URL, wait_until="domcontentloaded")
            results[backend] = await page.evaluate(SCRIPT, {"w": W, "h": H, "backend": backend})
            await page.close()
        await b.close()

    for k, v in results.items():
        if not v.get("ok"):
            print(f"{k}: {v.get('why')}")
    if not results["webgpu"].get("ok"):
        print("\nSKIPPED — WebGPU unavailable in this browser")
        return 0
    if not results["webgl2"].get("ok"):
        print("\nFAIL — WebGL2 unavailable, nothing to compare against")
        return 1

    print(f"backends: {results['webgl2']['backend']} vs {results['webgpu']['backend']}\n")
    good = True
    for mode in results["webgl2"]["sigs"]:
        a = results["webgl2"]["sigs"][mode]
        c = results["webgpu"]["sigs"][mode]
        same, flip = compare(a, c)
        verdict = "OK" if same < 14 else ("FLIPPED" if flip < same else "DIFFERENT")
        print(f"  {mode:12} mean|diff| {same:6.2f}   (flipped {flip:6.2f})   {verdict}")
        if verdict != "OK":
            good = False
    print("\nPASS — WebGPU matches WebGL 2, same orientation"
          if good else "\nFAIL — the backends disagree")
    return 0 if good else 1

sys.exit(asyncio.run(main()))
