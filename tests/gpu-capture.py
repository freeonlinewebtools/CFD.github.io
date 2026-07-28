"""Does image export actually contain the field on each backend?

A WebGPU canvas has no `preserveDrawingBuffer`: once a frame is presented the
texture is gone, so any `drawImage` from a later task reads black. Both the PNG
export and the recorder compose from a separate task, which made every captured
frame empty on WebGPU while the app looked perfect on screen — a failure with no
symptom until you open the file.

So this exports through the app's own File > Save image path, reads the
resulting PNG back, and checks it is not a black rectangle. Run for both
backends; WebGL 2 is the control.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/gpu-capture.py [port]
"""
import asyncio, base64, sys, tempfile, os
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"

MEASURE = """
async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = Math.min(img.width, 320);
  c.height = Math.min(img.height, 200);
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, c.width, c.height);
  const px = x.getImageData(0, 0, c.width, c.height).data;
  let mn = 255, mx = 0, sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] + px[i+1] + px[i+2]) / 3;
    if (l < mn) mn = l;
    if (l > mx) mx = l;
    sum += l; n++;
  }
  return { w: img.width, h: img.height, min: mn, max: mx,
           mean: +(sum / n).toFixed(1), spread: mx - mn };
}
"""

async def capture(pw, backend):
    b = await pw.chromium.launch(channel="chrome", headless=True,
                                 args=["--use-gl=angle", "--enable-unsafe-swiftshader"])
    ctx = await b.new_context(viewport={"width": 1400, "height": 860},
                              accept_downloads=True)
    await ctx.add_init_script(
        f"try {{ localStorage.setItem('hyperfoam-backend', '{backend}'); }} catch (e) {{}}")
    page = await ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    await page.goto(URL, wait_until="networkidle")
    await page.wait_for_timeout(5000)

    active = await page.evaluate("() => document.getElementById('backend')?.textContent")

    async with page.expect_download() as dl:
        await page.click('.mb-t:text-is("File")')
        await page.wait_for_timeout(150)
        await page.click('.mb-i:has(.mb-lbl:text-is("Save image"))')
    download = await dl.value
    path = os.path.join(tempfile.gettempdir(), f"hf-{backend}.png")
    await download.save_as(path)
    with open(path, "rb") as f:
        raw = f.read()
    stats = await page.evaluate(MEASURE, base64.b64encode(raw).decode())
    await b.close()
    return active, len(raw), stats, errs

async def main():
    results = {}
    async with async_playwright() as pw:
        for backend in ("webgl2", "webgpu"):
            try:
                results[backend] = await capture(pw, backend)
            except Exception as e:
                results[backend] = (None, 0, {"error": str(e)[:120]}, [])

    good = True
    for backend, (active, nbytes, stats, errs) in results.items():
        if "error" in stats:
            print(f"  {backend:8} FAILED: {stats['error']}")
            good = False
            continue
        ok = stats["spread"] > 25 and stats["mean"] > 8
        print(f"  {backend:8} active={active:7} {nbytes/1024:7.1f} KB  "
              f"mean={stats['mean']:6}  spread={stats['spread']:5}  "
              f"{'OK' if ok else 'BLANK'}")
        if errs:
            print(f"           page errors: {errs[:2]}")
        if not ok:
            good = False
    print("\nPASS — exported images contain the field on every backend"
          if good else "\nFAIL — an exported image came back blank")
    return 0 if good else 1

sys.exit(asyncio.run(main()))
