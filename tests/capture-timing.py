"""Does a stuttering render produce a stuttering file?

This is the regression the user reported and the one nothing caught. Offline
capture is supposed to be independent of how long each frame took to produce,
so the test induces a deliberate, uneven stall — a long pause every tenth frame,
like a GC hitch or a slow solver step — and then checks the resulting file's
timeline.

  muxed (WebCodecs -> mp4.js / webm.js) : duration must be exactly frames/fps
  MediaRecorder                         : stamps by wall clock, so it inflates

Both are measured, because the contrast is the point: MediaRecorder is not
broken, it is simply the wrong tool for an offline render, and this shows by how
much.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/capture-timing.py [port]
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"
FPS, FRAMES, STALL_MS = 30, 60, 90

SCRIPT = """
async ({fps, frames, stallMs}) => {
  const { muxMP4 } = await import('/src/mp4.js');
  const { muxWebM } = await import('/src/webm.js');
  const W = 320, H = 240;
  if (typeof VideoEncoder !== 'function') return { skipped: 'no WebCodecs' };

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  let n = 0;
  // Draw one frame, stalling hard every tenth to imitate a hitching render.
  const drawFrame = () => {
    ctx.fillStyle = `hsl(${n * 6}, 80%, 50%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect((n * 4) % W, 100, 40, 40);
    if (n % 10 === 0) { const t = performance.now(); while (performance.now() - t < stallMs); }
    n++;
    return cv;
  };

  const durationOf = async blob => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement('video');
    v.muted = true; v.src = url;
    const ok = await new Promise(res => {
      v.onloadedmetadata = () => res(true);
      v.onerror = () => res(false);
      setTimeout(() => res(false), 8000);
    });
    const d = ok ? v.duration : null;
    URL.revokeObjectURL(url);
    return d;
  };

  const out = {};

  for (const [name, codec] of [['mp4', 'avc1.42003E'], ['webm', 'vp09.00.10.08']]) {
    n = 0;
    const cfg = { codec, width: W, height: H, bitrate: 1_500_000, framerate: fps };
    if (name === 'mp4') cfg.avc = { format: 'avc' };
    const sup = await VideoEncoder.isConfigSupported(cfg);
    if (!sup || !sup.supported) { out[name] = { supported: false }; continue; }

    const chunks = [];
    let description = null;
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
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const canvas = drawFrame();
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps),
                                          duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % 30 === 0 });
      vf.close();
      if (enc.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
    }
    await enc.flush();
    enc.close();
    const wall = (performance.now() - t0) / 1000;
    const blob = name === 'mp4'
      ? muxMP4({ chunks, description, width: W, height: H, fps })
      : muxWebM({ chunks, width: W, height: H, fps });
    out[name] = { supported: true, wallSeconds: +wall.toFixed(2),
                  duration: await durationOf(blob), bytes: blob.size };
  }

  // MediaRecorder over the same stalling source, for contrast.
  if (typeof MediaRecorder === 'function' && cv.captureStream) {
    n = 0;
    const stream = cv.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = ['video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime });
    const parts = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });
    rec.start();
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      drawFrame();
      if (track.requestFrame) track.requestFrame();
      await new Promise(r => setTimeout(r, 0));
    }
    rec.stop();
    await done;
    const wall = (performance.now() - t0) / 1000;
    const blob = new Blob(parts, { type: mime });
    out.mediaRecorder = { supported: true, wallSeconds: +wall.toFixed(2),
                          duration: await durationOf(blob), bytes: blob.size };
  }
  return out;
}
"""

async def main():
    async with async_playwright() as pw:
        b = await pw.chromium.launch(channel="chrome", headless=True,
                                     args=["--use-gl=angle", "--enable-unsafe-swiftshader",
                                           "--autoplay-policy=no-user-gesture-required"])
        page = await b.new_page()
        await page.goto(URL, wait_until="domcontentloaded")
        r = await page.evaluate(SCRIPT, {"fps": FPS, "frames": FRAMES, "stallMs": STALL_MS})
        await b.close()

    if r.get("skipped"):
        print("SKIPPED:", r["skipped"]); return 0
    want = FRAMES / FPS
    print(json.dumps(r, indent=2))
    print(f"\nintended duration: {want:.3f} s "
          f"({FRAMES} frames at {FPS} fps, with a {STALL_MS} ms stall every 10th)")

    good = True
    for name in ("mp4", "webm"):
        e = r.get(name, {})
        if not e.get("supported"):
            print(f"  {name:14} unsupported — skipped"); continue
        d = e["duration"]
        drift = abs(d - want)
        status = "OK" if drift < 0.05 else "DRIFTED"
        print(f"  {name:14} {d:.3f} s  (render took {e['wallSeconds']:.2f} s)  {status}")
        if drift >= 0.05:
            good = False
    mr = r.get("mediaRecorder")
    if mr and mr.get("duration"):
        print(f"  {'mediaRecorder':14} {mr['duration']:.3f} s  "
              f"(render took {mr['wallSeconds']:.2f} s)  <- follows wall clock, for contrast")

    print("\nPASS — the muxed timeline ignores how long rendering took"
          if good else "\nFAIL — the file's duration tracked render time")
    return 0 if good else 1

sys.exit(asyncio.run(main()))
