"""Does an exported MP4 actually move at a constant rate?

The judder bug was invisible to every existing check: the container timing was
exact, the frame count was right, and the file played. What was wrong was how
much SIMULATION each evenly-spaced frame contained, which only shows up as
motion. So this measures the thing the viewer actually sees — decode every
frame, difference consecutive pairs, and look at how much that varies.

A capture that advances a fixed step per frame gives a near-constant
difference. One that re-derives its step from the instantaneous flow speed
gives a difference that swings with the flow, which is what "it stutters" means.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/mp4-motion.py [port]
"""
import asyncio, json, sys, statistics
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"
FPS, SECONDS = 30, 3

RECORD = """
async ({fps, seconds}) => {
  const { Grid } = await import('/src/grid.js');
  const { NavierStokes } = await import('/src/ns.js');
  const { Scene, Shapes } = await import('/src/scene.js');
  const { Raster } = await import('/src/raster.js');
  const { PALETTE } = await import('/src/colormaps.js');
  const { Recorder, captureStep, subSteps } = await import('/src/recorder.js');
  const { muxMP4 } = await import('/src/mp4.js');

  const nx = 192, ny = 96, U = 2.4, targetCFL = 1;
  const g = new Grid(nx, ny);
  const ns = new NavierStokes(g);
  ns.windTunnel = true; g.openX = true; ns.inletSpeed = U; ns.visc = 0.02;
  ns.speedCap = U * 25;
  const scene = new Scene(nx, ny);
  scene.add(Shapes.circle(nx * 0.3, (ny + 1) / 2, 10));
  const r = new Raster(nx, ny); r.build(scene); r.applyTo(g, U);
  ns.onGeometryChanged(); ns.seedFreestream();
  for (let i = 0; i < 300; i++) ns.step(0.2, PALETTE);   // develop a wake

  const cv = document.createElement('canvas');
  cv.width = nx * 2; cv.height = ny * 2;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(nx, ny);
  const small = document.createElement('canvas');
  small.width = nx; small.height = ny;
  const sx = small.getContext('2d');

  // Exactly the wiring main.js uses.
  const dtFrame = captureStep({ targetCFL, uRef: Math.max(U, ns.measureMaxSpeed()), scale: 1 });
  const dts = [];
  const rec = new Recorder({
    dtFor: () => dtFrame,
    stepOnce: dt => {
      dts.push(dt);
      const n = subSteps(dt, ns.measureMaxSpeed(), targetCFL);
      for (let k = 0; k < n; k++) ns.step(dt / n, PALETTE);
    },
    renderOnce: () => {
      // Plain speed field, no colormap subtleties needed.
      const d = img.data;
      for (let j = 1; j <= ny; j++) for (let i = 1; i <= nx; i++) {
        const idx = i + j * g.stride, o = ((j - 1) * nx + (i - 1)) * 4;
        const s = Math.hypot(g.u[idx], g.v[idx]) / (U * 2.5);
        const v = Math.max(0, Math.min(1, s)) * 255;
        d[o] = v; d[o+1] = v; d[o+2] = v; d[o+3] = 255;
      }
      sx.putImageData(img, 0, 0);
      cx.drawImage(small, 0, 0, cv.width, cv.height);
    },
    compose: () => cv,
    yieldFrame: () => Promise.resolve(),
  });

  const chunks = [];
  let description = null;
  const cfg = { codec: 'avc1.42003E', width: cv.width, height: cv.height,
                bitrate: 4_000_000, framerate: fps, avc: { format: 'avc' } };
  const sup = await VideoEncoder.isConfigSupported(cfg);
  if (!sup || !sup.supported) return { skipped: 'avc1 unsupported' };
  const enc = new VideoEncoder({
    output: (c, md) => {
      const d = md && md.decoderConfig && md.decoderConfig.description;
      if (d && !description) description = d;
      const b = new Uint8Array(c.byteLength); c.copyTo(b);
      chunks.push({ data: b, keyframe: c.type === 'key', duration: c.duration });
    },
    error: e => { throw e; },
  });
  enc.configure(cfg);

  const frames = fps * seconds;
  for (let i = 0; i < frames; i++) {
    const canvas = rec.frame(1);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps),
                                        duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % 30 === 0 });
    vf.close();
    if (enc.encodeQueueSize > 8) await new Promise(r2 => setTimeout(r2, 0));
  }
  await enc.flush();
  enc.close();

  const blob = muxMP4({ chunks, description, width: cv.width, height: cv.height, fps });
  window.__mp4url = URL.createObjectURL(blob);
  return { frames, bytes: blob.size, distinctDts: [...new Set(dts)], dtFrame };
}
"""

MEASURE = """
async ({fps, frames}) => {
  const v = document.createElement('video');
  v.muted = true; v.src = window.__mp4url;
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = rej;
                                    setTimeout(rej, 8000); });
  const w = 160, h = 80;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });

  const diffs = [];
  let prev = null;
  for (let i = 2; i < frames - 2; i++) {
    const t = (i + 0.5) / fps;
    await new Promise(res => { v.onseeked = res; v.currentTime = t; setTimeout(res, 3000); });
    ctx.drawImage(v, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const g = new Float64Array(w * h);
    for (let k = 0; k < g.length; k++) g[k] = px[k * 4];
    if (prev) {
      let s = 0;
      for (let k = 0; k < g.length; k++) s += Math.abs(g[k] - prev[k]);
      diffs.push(s / g.length);
    }
    prev = g;
  }
  return diffs;
}
"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                           "--autoplay-policy=no-user-gesture-required"])
        page = await b.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        await page.goto(URL, wait_until="domcontentloaded")

        rec = await page.evaluate(RECORD, {"fps": FPS, "seconds": SECONDS})
        if rec.get("skipped"):
            print("SKIPPED:", rec["skipped"]); return 0
        print(json.dumps(rec, indent=2))

        diffs = await page.evaluate(MEASURE, {"fps": FPS, "frames": rec["frames"]})
        await b.close()

    if len(diffs) < 10:
        print("FAIL — could not sample enough frames"); return 1
    mean = statistics.fmean(diffs)
    cv = statistics.pstdev(diffs) / mean if mean else 99
    print(f"\nframe-to-frame difference: mean {mean:.3f}, "
          f"min {min(diffs):.3f}, max {max(diffs):.3f}")
    print(f"coefficient of variation:  {cv:.3f}   (lower = steadier motion)")
    if errs:
        print("page errors:", errs)

    steady_dt = len(rec["distinctDts"]) == 1
    print(f"\ndistinct per-frame sim steps: {len(rec['distinctDts'])} "
          f"({'constant' if steady_dt else 'VARYING — this is the judder'})")
    good = steady_dt and cv < 0.35
    print("\nPASS — motion advances at a constant rate" if good
          else "\nFAIL — motion rate is uneven")
    return 0 if good else 1

sys.exit(asyncio.run(main()))
