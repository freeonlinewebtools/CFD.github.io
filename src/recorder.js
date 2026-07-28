/* Offline capture.
 *
 * Frames are produced by stepping the solver a FIXED amount per output frame
 * and rendering each one, rather than by grabbing whatever the realtime loop
 * happens to draw. That decoupling is the whole point: a 60 fps recording of a
 * simulation running at 18 fps is still 60 fps of smooth motion, and the
 * result is identical whether the machine was busy or idle. Recording the
 * realtime loop instead would bake every dropped frame into the file.
 *
 * Encoders, in order of preference:
 *   WebCodecs      → MP4 (H.264), real bitrate control, no realtime constraint
 *   MediaRecorder  → WebM, wall-clock bound, so the capture must be paced
 *   PNG sequence   → a ZIP of frames, works everywhere, lossless
 *
 * WebCodecs emits an elementary stream — encoded frames with nothing around
 * them. Written straight to a file that produces something no player will open:
 * the bytes are valid, but nothing says where the frames are or how long each
 * lasts. `mp4.js` and `webm.js` wrap them in real containers, so BOTH video
 * formats come off the frame-exact path.
 *
 * MediaRecorder is now a fallback for browsers without WebCodecs, not a
 * shortcut for WebM. It timestamps by wall clock, which silently reintroduces
 * exactly the coupling this module exists to avoid: a frame that took 50 ms to
 * render becomes a 50 ms frame in the file, so the export stutters wherever the
 * machine did.
 *
 * GIF is deliberately absent. At 256 colours it renders a continuous field
 * badly and the files are enormous; a WebM at the same quality is smaller by
 * an order of magnitude. PNG frames are offered instead for anyone who needs
 * to assemble something externally.
 */

import { muxMP4 } from './mp4.js';
import { muxWebM } from './webm.js';

export const FORMATS = [
  { id: 'mp4', label: 'MP4 (H.264)', codec: 'avc1.42003E', mime: 'video/mp4' },
  { id: 'webm', label: 'WebM (VP9)', codec: 'vp09.00.10.08', mime: 'video/webm' },
  { id: 'png', label: 'PNG sequence (ZIP)', mime: 'application/zip' },
];

/* Simulated time for ONE OUTPUT FRAME, held fixed for a whole capture.
 *
 * The realtime loop re-derives its timestep from the instantaneous peak speed
 * every frame, to hold CFL near 1. Reusing that for capture is the bug this
 * function exists to prevent: the frames in the file are evenly spaced in TIME,
 * but each one advances the simulation by a different amount, so the motion
 * juddered — worst exactly when the flow sped up, which also happens to be when
 * the viewport stutters. The result looked like a screen recording.
 *
 * So the step is decided once, from the REFERENCE speed rather than the current
 * peak, and never revisited: pressing record at a calm moment and a busy one
 * must give the same playback rate. Stability is handled by `subSteps`.
 */
export function captureStep({ targetCFL = 1, uRef = 1, scale = 1 }) {
  const u = Math.max(uRef, 1e-6);
  const base = Math.min(0.4, Math.max(1e-4, (targetCFL * Math.min(1, scale)) / u));
  return base * Math.max(1, Math.ceil(scale));
}

/* How many solver steps one fixed frame step must be divided into to stay
 * inside the CFL target at the current peak speed.
 *
 * This is where a speed-up is paid for — in step COUNT, never in simulated
 * time. The cap stops a transient spike (a fresh obstacle, a brush stroke)
 * from turning one frame into thousands of steps and appearing to hang. */
export function subSteps(dt, uMax, targetCFL = 1, cap = 64) {
  const stable = uMax > 1e-6 ? Math.min(0.4, Math.max(1e-4, targetCFL / uMax)) : 0.4;
  return Math.max(1, Math.min(cap, Math.ceil(dt / stable)));
}

export function capabilities() {
  const hasWebCodecs = typeof window !== 'undefined'
    && typeof window.VideoEncoder === 'function'
    && typeof window.VideoFrame === 'function';
  const hasRecorder = typeof window !== 'undefined' && typeof window.MediaRecorder === 'function';
  return {
    webCodecs: hasWebCodecs,
    mediaRecorder: hasRecorder,
    best: hasWebCodecs ? 'webcodecs' : hasRecorder ? 'mediarecorder' : 'png',
  };
}

/* Minimal stored-ZIP writer. No compression — PNG is already deflated, so a
 * second pass would cost time and save nothing. */
function crc32(buf) {
  let c, table = crc32.t;
  if (!table) {
    table = crc32.t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function zip(files) {
  const chunks = [], central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = new DataView(new ArrayBuffer(30));
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true); head.setUint16(6, 0, true); head.setUint16(8, 0, true);
    head.setUint16(10, 0, true); head.setUint16(12, 0, true);
    head.setUint32(14, crc, true);
    head.setUint32(18, f.data.length, true);
    head.setUint32(22, f.data.length, true);
    head.setUint16(26, name.length, true); head.setUint16(28, 0, true);
    chunks.push(new Uint8Array(head.buffer), name, f.data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, f.data.length, true);
    cd.setUint32(24, f.data.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(new Uint8Array(cd.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export class Recorder {
  /* host supplies:
   *   stepOnce(dt)   advance the simulation by exactly dt
   *   renderOnce()   draw one frame into the canvases
   *   compose()      → canvas holding the finished frame
   *   dtFor(scale)   simulation time for one output frame
   */
  constructor(host) {
    this.host = host;
    this.active = false;
    this.cancelled = false;
  }

  cancel() { this.cancelled = true; }

  async run(opts, onProgress = () => {}) {
    const { frames, fps, format, quality, scale } = opts;
    this.active = true;
    this.cancelled = false;
    const caps = capabilities();
    try {
      if (format === 'png') return await this.png(frames, fps, scale, onProgress);
      if (caps.webCodecs) return await this.webCodecs(frames, fps, format, quality, scale, onProgress);
      if (caps.mediaRecorder) return await this.mediaRecorder(frames, fps, quality, scale, onProgress);
      return await this.png(frames, fps, scale, onProgress);
    } finally {
      this.active = false;
    }
  }

  /* Advance and draw one output frame, then hand back the composed canvas. */
  frame(scale) {
    this.host.stepOnce(this.host.dtFor(scale));
    this.host.renderOnce();
    return this.host.compose();
  }

  /* Hand the main thread back so the browser can paint.
   *
   * Without this the whole capture runs inside one task and the viewport shows
   * nothing until it finishes — on a thirty-second render that is a minute or
   * more of a frozen window with no sign it is working. Yielding once per
   * frame makes the viewport a live preview of the render, and is also what
   * lets the cancel button be pressed at all. */
  async yieldToBrowser() {
    if (this.host.yieldFrame) await this.host.yieldFrame();
    else await new Promise(r => setTimeout(r, 0));
  }

  async webCodecs(frames, fps, format, quality, scale, onProgress) {
    const fmt = FORMATS.find(f => f.id === format) || FORMATS[1];
    const probe = this.host.compose();
    // Encoders reject odd dimensions for most profiles.
    const width = probe.width - (probe.width % 2);
    const height = probe.height - (probe.height % 2);

    const chunks = [];
    let description = null;
    let encoder = null;
    const config = {
      codec: fmt.codec, width, height,
      bitrate: Math.round(width * height * fps * quality * 0.07),
      framerate: fps,
    };
    // Length-prefixed AVCC, which is what `avcC` and the MP4 muxer expect.
    // Annex-B start codes would produce a file that looks right and plays as
    // garbage. Only meaningful for H.264.
    if (fmt.id === 'mp4') config.avc = { format: 'avc' };
    const support = await window.VideoEncoder.isConfigSupported(config).catch(() => null);
    if (!support || !support.supported) {
      // Fall back rather than fail: codec availability varies by platform.
      if (capabilities().mediaRecorder) return this.mediaRecorder(frames, fps, quality, scale, onProgress);
      return this.png(frames, fps, scale, onProgress);
    }

    encoder = new window.VideoEncoder({
      output: (c, metadata) => {
        // The avcC record arrives once, alongside the first chunk. Without it
        // there is nothing to put in the sample description and the file is
        // unplayable, so keep the first one that turns up.
        const d = metadata && metadata.decoderConfig && metadata.decoderConfig.description;
        if (d && !description) description = d;
        const buf = new Uint8Array(c.byteLength);
        c.copyTo(buf);
        chunks.push({ data: buf, keyframe: c.type === 'key', timestamp: c.timestamp, duration: c.duration });
      },
      error: e => { throw e; },
    });
    encoder.configure(config);

    for (let i = 0; i < frames; i++) {
      if (this.cancelled) break;
      const canvas = this.frame(scale);
      const vf = new window.VideoFrame(canvas, {
        timestamp: Math.round((i * 1e6) / fps),
        duration: Math.round(1e6 / fps),
      });
      encoder.encode(vf, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      vf.close();
      if (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 0));
      onProgress((i + 1) / frames, i + 1, frames);
      await this.yieldToBrowser();
    }
    await encoder.flush();
    encoder.close();

    if (!chunks.length) throw new Error('encoder produced no data');

    // Wrap the elementary stream in a real container. If that cannot be done —
    // the encoder withheld the avcC record, say — fall back to a format that is
    // actually playable rather than hand back a file no player opens.
    try {
      return fmt.id === 'mp4'
        ? { blob: muxMP4({ chunks, description, width, height, fps }), ext: 'mp4', frames: chunks.length }
        : { blob: muxWebM({ chunks, width, height, fps }), ext: 'webm', frames: chunks.length };
    } catch (err) {
      if (capabilities().mediaRecorder) return this.mediaRecorder(frames, fps, quality, scale, onProgress);
      return this.png(frames, fps, scale, onProgress);
    }
  }

  async mediaRecorder(frames, fps, quality, scale, onProgress) {
    const probe = this.host.compose();
    const stream = probe.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mimes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    const mime = mimes.find(m => window.MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const rec = new window.MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: Math.round(probe.width * probe.height * fps * quality * 0.07),
    });
    const parts = [];
    rec.ondataavailable = e => { if (e.data.size) parts.push(e.data); };
    const done = new Promise(res => { rec.onstop = res; });
    rec.start();

    for (let i = 0; i < frames; i++) {
      if (this.cancelled) break;
      this.frame(scale);
      // requestFrame decides WHEN a frame is captured, but MediaRecorder still
      // stamps it with the wall clock — so this path's timeline follows real
      // time, and a slow frame is a slow frame in the file. That is why it is
      // now only reached when WebCodecs is unavailable; both muxers above give
      // a frame-exact timeline instead.
      if (track.requestFrame) track.requestFrame();
      onProgress((i + 1) / frames, i + 1, frames);
      await this.yieldToBrowser();
    }
    rec.stop();
    await done;
    return { blob: new Blob(parts, { type: mime }), ext: 'webm', frames };
  }

  async png(frames, fps, scale, onProgress) {
    const files = [];
    for (let i = 0; i < frames; i++) {
      if (this.cancelled) break;
      const canvas = this.frame(scale);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      files.push({ name: `frame_${String(i).padStart(5, '0')}.png`, data: buf });
      onProgress((i + 1) / frames, i + 1, frames);
      await this.yieldToBrowser();
    }
    if (!files.length) throw new Error('no frames captured');
    return { blob: zip(files), ext: 'zip', frames: files.length, note: `${fps} fps when assembled.` };
  }
}
