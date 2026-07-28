"""End-to-end proof that the muxed WebM is actually playable.

tests/mp4.mjs checks the box tree with synthetic samples. That is necessary but
not sufficient — the bug it replaces produced a file that was structurally
"fine" byte-wise and that no player would open. So this encodes REAL frames with
the browser's own VideoEncoder, muxes them with src/webm.js, and then hands the
result back to the browser's demuxer through a <video> element. If Chrome
reports a duration and decodes a frame, the container is right.

Needs a server on the project root:  python -m http.server 8123
Run:                                 python tests/webm-play.py [port]
Playwright and Chrome are already present; nothing is downloaded.
"""
import asyncio, json, sys
from playwright.async_api import async_playwright

PORT = sys.argv[1] if len(sys.argv) > 1 else "8123"
URL = f"http://localhost:{PORT}/"

SCRIPT = """
async () => {
  const { muxWebM } = await import('/src/webm.js');
  const W = 320, H = 240, FPS = 30, N = 60;

  if (typeof VideoEncoder !== 'function') return { skipped: 'no WebCodecs' };

  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d');

  const chunks = [];
  let description = null;
  const cfg = { codec: 'vp09.00.10.08', width: W, height: H, bitrate: 1_200_000,
                framerate: FPS, avc: { format: 'avc' } };
  const sup = await VideoEncoder.isConfigSupported(cfg);
  if (!sup || !sup.supported) return { skipped: 'vp9 unsupported' };

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

  for (let i = 0; i < N; i++) {
    // Moving content, so a static-image false positive is impossible.
    ctx.fillStyle = `hsl(${i * 6}, 80%, 50%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect((i * 4) % W, 100, 40, 40);
    const vf = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / FPS),
                                    duration: Math.round(1e6 / FPS) });
    enc.encode(vf, { keyFrame: i % 30 === 0 });
    vf.close();
  }
  await enc.flush();
  enc.close();

  const blob = muxWebM({ chunks, width: W, height: H, fps: FPS });

  // Does the browser's own demuxer accept it?
  const url = URL.createObjectURL(blob);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.src = url;
  const meta = await new Promise(res => {
    const done = ok => res(ok);
    v.onloadedmetadata = () => done(true);
    v.onerror = () => done(false);
    setTimeout(() => done(false), 8000);
  });
  if (!meta) return { ok: false, why: 'video element rejected the file',
                      bytes: blob.size, mime: blob.type };

  // Seek into the middle and confirm a frame actually decodes to pixels.
  await new Promise(res => { v.onseeked = res; v.currentTime = 1.0; setTimeout(res, 5000); });
  const probe = document.createElement('canvas');
  probe.width = W; probe.height = H;
  const pctx = probe.getContext('2d');
  let decoded = false, spread = 0;
  try {
    pctx.drawImage(v, 0, 0, W, H);
    const px = pctx.getImageData(0, 0, W, H).data;
    let mn = 255, mx = 0;
    for (let i = 0; i < px.length; i += 4) {
      const l = (px[i] + px[i+1] + px[i+2]) / 3;
      if (l < mn) mn = l; if (l > mx) mx = l;
    }
    spread = mx - mn;
    decoded = spread > 12;      // a real frame, not a blank canvas
  } catch (e) { decoded = false; }

  URL.revokeObjectURL(url);
  return {
    ok: true, bytes: blob.size, mime: blob.type,
    duration: Number(v.duration.toFixed(3)), expected: N / FPS,
    videoWidth: v.videoWidth, videoHeight: v.videoHeight,
    seekedTo: Number(v.currentTime.toFixed(3)),
    decodedFrame: decoded, pixelSpread: spread,
    frames: chunks.length,
  };
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
        r = await page.evaluate(SCRIPT)
        await b.close()

    print(json.dumps(r, indent=2))
    if errs:
        print("page errors:", errs)
    if r.get("skipped"):
        print(f"\nSKIPPED: {r['skipped']}")
        return 0
    good = (r.get("ok") and r.get("decodedFrame")
            and abs(r["duration"] - r["expected"]) < 0.1
            and r["videoWidth"] == 320 and r["videoHeight"] == 240)
    print("\nPASS — Chrome demuxed, seeked and decoded the muxed WebM"
          if good else "\nFAIL — the container was not accepted")
    return 0 if good else 1

sys.exit(asyncio.run(main()))
