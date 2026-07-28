/* Minimal ISO base media file format (MP4) muxer for a single H.264 track.
 *
 * WebCodecs hands back *elementary stream* chunks — encoded frames with no
 * container around them. Writing those to a .mp4 produces a file every player
 * rejects, which is exactly what this project shipped before: the bytes were
 * valid H.264 and the file was unopenable. A container is not optional
 * packaging, it is what tells a demuxer where the frames are, how big they
 * are, when to show them and which ones can be seeked to.
 *
 * Only what a progressive video-only MP4 needs is implemented:
 *
 *   ftyp                  brand declaration
 *   mdat                  the sample data, verbatim
 *   moov > mvhd           movie header
 *          trak > tkhd    track header
 *                 mdia > mdhd / hdlr
 *                        minf > vmhd / dinf
 *                               stbl > stsd > avc1 > avcC   what the codec is
 *                                      stts                 how long each frame lasts
 *                                      stss                 which frames are seekable
 *                                      stsc / stsz / stco   where each frame is
 *
 * No audio, no edit lists, no fragmentation. `mdat` is written BEFORE `moov`
 * so the sample offsets are known by the time the index is built, which means
 * one pass and no patching.
 *
 * The encoder must be configured with `avc: { format: 'avc' }` (the default) so
 * chunks are length-prefixed AVCC rather than Annex-B start codes — the two are
 * not interchangeable, and `avcC` describes the former. `description` on the
 * encoder's decoderConfig IS the AVCDecoderConfigurationRecord, so it is copied
 * in whole rather than rebuilt from the SPS/PPS.
 */

const FIXED_ONE = 0x00010000;                 // 16.16 fixed point 1.0
const UNITY_MATRIX = [FIXED_ONE, 0, 0, 0, FIXED_ONE, 0, 0, 0, 0x40000000];
const MOVIE_TIMESCALE = 1000;                 // movie header ticks per second
const MEDIA_TIMESCALE = 90000;                // divides exactly by 24/25/30/50/60

const u8 = a => new Uint8Array(a);
const str = s => u8([...s].map(c => c.charCodeAt(0)));

function u16(v) { return u8([v >> 8 & 255, v & 255]); }
function u32(v) {
  return u8([(v / 0x1000000) & 255, v >> 16 & 255, v >> 8 & 255, v & 255]);
}
function u64(v) {
  const hi = Math.floor(v / 0x100000000);
  return u8([...u32(hi), ...u32(v >>> 0)]);
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* size + fourcc + payload. */
function box(type, ...parts) {
  const body = concat(parts);
  return concat([u32(body.length + 8), str(type), body]);
}

/* A box carrying a version byte and 24 flag bits. */
function fullBox(type, version, flags, ...parts) {
  return box(type, u8([version, flags >> 16 & 255, flags >> 8 & 255, flags & 255]), ...parts);
}

/* Build the moov index for `samples`, each { size, duration, keyframe },
 * whose bytes start at `baseOffset` in the file. */
function moov({ samples, width, height, avcC, baseOffset }) {
  const n = samples.length;
  let mediaDuration = 0;
  for (const s of samples) mediaDuration += s.duration;
  const movieDuration = Math.round(mediaDuration * MOVIE_TIMESCALE / MEDIA_TIMESCALE);

  // stts: run-length encode equal durations. A fixed-step capture collapses to
  // a single entry, but a trailing frame can differ, so do not assume it.
  const stts = [];
  for (const s of samples) {
    const last = stts[stts.length - 1];
    if (last && last.delta === s.duration) last.count++;
    else stts.push({ count: 1, delta: s.duration });
  }

  const syncs = [];
  for (let i = 0; i < n; i++) if (samples[i].keyframe) syncs.push(i + 1);
  // Every frame being a sync sample is the default; the box is only needed to
  // say that some are NOT.
  const needStss = syncs.length !== n;

  const mvhd = fullBox('mvhd', 0, 0,
    u32(0), u32(0),                             // creation / modification time
    u32(MOVIE_TIMESCALE), u32(movieDuration),
    u32(FIXED_ONE),                             // rate 1.0
    u16(0x0100),                                // volume 1.0
    u16(0), u32(0), u32(0),                     // reserved
    ...UNITY_MATRIX.map(u32),
    ...Array(6).fill(u32(0)),                   // pre_defined
    u32(2));                                    // next track id

  const tkhd = fullBox('tkhd', 0, 3,            // enabled | in movie
    u32(0), u32(0),
    u32(1),                                     // track id
    u32(0),
    u32(movieDuration),
    u32(0), u32(0),
    u16(0), u16(0),                             // layer, alternate group
    u16(0), u16(0),                             // volume (0 for video), reserved
    ...UNITY_MATRIX.map(u32),
    u32(width * FIXED_ONE), u32(height * FIXED_ONE));

  const mdhd = fullBox('mdhd', 0, 0,
    u32(0), u32(0),
    u32(MEDIA_TIMESCALE), u32(mediaDuration),
    u16(0x55c4),                                // language 'und'
    u16(0));

  const hdlr = fullBox('hdlr', 0, 0,
    u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler\0'));

  const dinf = box('dinf',
    fullBox('dref', 0, 0, u32(1),
      fullBox('url ', 0, 1)));                  // flag 1: data is in this file

  const avc1 = box('avc1',
    u8([0, 0, 0, 0, 0, 0]),                     // reserved
    u16(1),                                     // data reference index
    u16(0), u16(0), u32(0), u32(0), u32(0),     // pre_defined / reserved
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000),           // 72 dpi
    u32(0),
    u16(1),                                     // frame count
    u8(new Array(32).fill(0)),                  // compressor name
    u16(0x0018),                                // depth
    u16(0xffff),                                // pre_defined = -1
    box('avcC', avcC));

  const stbl = box('stbl',
    fullBox('stsd', 0, 0, u32(1), avc1),
    fullBox('stts', 0, 0, u32(stts.length),
      ...stts.map(e => concat([u32(e.count), u32(e.delta)]))),
    ...(needStss ? [fullBox('stss', 0, 0, u32(syncs.length), ...syncs.map(u32))] : []),
    fullBox('stsc', 0, 0, u32(1),
      concat([u32(1), u32(n), u32(1)])),        // one chunk holding every sample
    fullBox('stsz', 0, 0, u32(0), u32(n), ...samples.map(s => u32(s.size))),
    fullBox('stco', 0, 0, u32(1), u32(baseOffset)));

  const minf = box('minf',
    fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
    dinf, stbl);

  return box('moov', mvhd, box('trak', tkhd, box('mdia', mdhd, hdlr, minf)));
}

/* Wrap encoded H.264 chunks into a playable MP4.
 *
 * chunks: [{ data: Uint8Array, keyframe: boolean, duration?: microseconds }]
 * description: the AVCDecoderConfigurationRecord from the encoder's metadata.
 *
 * Returns a Blob. The sample bytes are handed to the Blob by reference rather
 * than copied into one big buffer — a 4K capture is hundreds of megabytes and
 * concatenating it would double peak memory for no reason.
 */
export function muxMP4({ chunks, description, width, height, fps }) {
  if (!chunks || !chunks.length) throw new Error('no encoded chunks to mux');
  if (!description) throw new Error('encoder gave no avcC description — cannot write MP4');

  const avcC = description instanceof Uint8Array ? description
    : new Uint8Array(description.buffer || description,
                     description.byteOffset || 0, description.byteLength);

  const defaultDur = Math.round(MEDIA_TIMESCALE / fps);
  const samples = chunks.map(c => ({
    size: c.data.length,
    keyframe: !!c.keyframe,
    duration: c.duration ? Math.max(1, Math.round(c.duration * MEDIA_TIMESCALE / 1e6)) : defaultDur,
  }));

  let payload = 0;
  for (const s of samples) payload += s.size;

  const ftyp = box('ftyp', str('isom'), u32(512),
    str('isom'), str('iso2'), str('avc1'), str('mp41'));

  // mdat needs the 64-bit `largesize` form once the payload passes 4 GB, and
  // the header length feeds the sample offsets, so decide before indexing.
  const big = payload + 8 > 0xffffffff;
  const mdatHeader = big
    ? concat([u32(1), str('mdat'), u64(payload + 16)])
    : concat([u32(payload + 8), str('mdat')]);

  const baseOffset = ftyp.length + mdatHeader.length;
  const index = moov({ samples, width, height, avcC, baseOffset });

  return new Blob([ftyp, mdatHeader, ...chunks.map(c => c.data), index],
    { type: 'video/mp4' });
}

/* Exported for tests: read the top-level box types out of a buffer. */
export function topLevelBoxes(bytes) {
  const out = [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  while (o + 8 <= bytes.length) {
    let size = dv.getUint32(o);
    const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(o + 8)); header = 16; }
    if (size < header) break;
    out.push({ type, size, offset: o, header });
    o += size;
  }
  return out;
}
