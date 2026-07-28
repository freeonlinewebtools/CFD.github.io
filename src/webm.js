/* Minimal Matroska (WebM) muxer for a single VP9 track.
 *
 * This exists for the same reason `mp4.js` does, and fixes a worse bug. WebM
 * used to be produced by MediaRecorder, driven by `captureStream(0)` plus
 * `requestFrame()`, with a comment claiming the file's timeline therefore
 * followed the simulation rather than wall time. It does not: `requestFrame`
 * decides WHEN a frame is captured, but MediaRecorder timestamps whatever it
 * receives by the real-time clock. So an offline render that took 50 ms on one
 * frame and 16 ms on the next produced a file with those intervals baked in —
 * the export stuttered whenever the machine did, which is precisely what the
 * decoupled capture was supposed to prevent.
 *
 * Muxing the WebCodecs output ourselves puts every video format on the same
 * frame-exact path, and leaves MediaRecorder as a fallback for browsers with no
 * WebCodecs at all.
 *
 * EBML in brief: every element is [ID][size][payload], where the ID already
 * carries its own length marker and the size is a variable-length integer whose
 * leading one-bit says how many bytes it occupies. Sizes here are always known
 * before writing, so nothing uses the streaming "unknown size" form.
 *
 *   EBML header          doctype "webm"
 *   Segment
 *     Info               timestamp scale + duration
 *     Tracks > TrackEntry  V_VP9, pixel dimensions
 *     Cluster*           one per keyframe, each holding SimpleBlocks
 *     Cues               so players can seek
 *
 * Timestamps are milliseconds (TimestampScale = 1e6 ns), which is Matroska's
 * convention and is why block timestamps are 16-bit and relative to a cluster.
 */

const TIMESCALE_NS = 1000000;          // 1 ms per tick

const ID = {
  EBML: [0x1A, 0x45, 0xDF, 0xA3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xF7],
  EBMLMaxIDLength: [0x42, 0xF2],
  EBMLMaxSizeLength: [0x42, 0xF3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],

  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xA9, 0x66],
  TimestampScale: [0x2A, 0xD7, 0xB1],
  Duration: [0x44, 0x89],
  MuxingApp: [0x4D, 0x80],
  WritingApp: [0x57, 0x41],

  Tracks: [0x16, 0x54, 0xAE, 0x6B],
  TrackEntry: [0xAE],
  TrackNumber: [0xD7],
  TrackUID: [0x73, 0xC5],
  TrackType: [0x83],
  FlagLacing: [0x9C],
  CodecID: [0x86],
  DefaultDuration: [0x23, 0xE3, 0x83],
  Video: [0xE0],
  PixelWidth: [0xB0],
  PixelHeight: [0xBA],

  Cluster: [0x1F, 0x43, 0xB6, 0x75],
  Timestamp: [0xE7],
  SimpleBlock: [0xA3],

  Cues: [0x1C, 0x53, 0xBB, 0x6B],
  CuePoint: [0xBB],
  CueTime: [0xB3],
  CueTrackPositions: [0xB7],
  CueTrack: [0xF7],
  CueClusterPosition: [0xF1],
};

const u8 = a => new Uint8Array(a);

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* Unsigned integer in as few bytes as possible (at least one). */
function uint(v) {
  const bytes = [];
  let x = Math.max(0, Math.floor(v));
  do { bytes.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
  return u8(bytes);
}

/* EBML variable-length integer: the leading one-bit marks the total width, and
 * the remaining bits carry the value. */
function vint(v) {
  let width = 1;
  while (width < 8 && v >= 2 ** (7 * width) - 1) width++;
  const out = new Uint8Array(width);
  let x = v;
  for (let i = width - 1; i >= 0; i--) { out[i] = x & 0xff; x = Math.floor(x / 256); }
  out[0] |= 1 << (8 - width);          // length marker
  return out;
}

const elem = (id, ...payload) => {
  const body = concat(payload);
  return concat([u8(id), vint(body.length), body]);
};
const uintElem = (id, v) => elem(id, uint(v));
const strElem = (id, s) => elem(id, u8([...s].map(c => c.charCodeAt(0))));
const floatElem = (id, v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, v);
  return elem(id, b);
};

/* A SimpleBlock: track number, timestamp relative to its cluster, flags. */
function simpleBlock(track, relTs, keyframe, data) {
  const head = new Uint8Array(4);
  head[0] = 0x80 | track;              // vint for track numbers 1..127
  new DataView(head.buffer).setInt16(1, relTs);
  head[3] = keyframe ? 0x80 : 0;
  return concat([u8(ID.SimpleBlock), vint(head.length + data.length), head, data]);
}

/* Wrap encoded VP9 chunks into a playable WebM.
 *
 * chunks: [{ data: Uint8Array, keyframe: boolean, duration?: microseconds }]
 * Returns a Blob. Sample bytes are copied into clusters rather than referenced,
 * because Matroska interleaves them with per-block headers — unlike MP4, where
 * `mdat` is one contiguous run and the Blob can hold them by reference.
 */
export function muxWebM({ chunks, width, height, fps }) {
  if (!chunks || !chunks.length) throw new Error('no encoded chunks to mux');

  const frameMs = 1000 / fps;
  const header = elem(ID.EBML,
    uintElem(ID.EBMLVersion, 1),
    uintElem(ID.EBMLReadVersion, 1),
    uintElem(ID.EBMLMaxIDLength, 4),
    uintElem(ID.EBMLMaxSizeLength, 8),
    strElem(ID.DocType, 'webm'),
    uintElem(ID.DocTypeVersion, 2),
    uintElem(ID.DocTypeReadVersion, 2));

  // Presentation time of each frame, in whole milliseconds. Derived from the
  // frame index rather than accumulated, so rounding cannot drift over a long
  // capture: at 30 fps an accumulated 33 ms would lose a third of a second
  // across a five-minute render.
  const times = chunks.map((c, i) => Math.round(i * frameMs));
  const durationMs = Math.round(chunks.length * frameMs);

  const info = elem(ID.Info,
    uintElem(ID.TimestampScale, TIMESCALE_NS),
    floatElem(ID.Duration, durationMs),
    strElem(ID.MuxingApp, 'HyperFOAM'),
    strElem(ID.WritingApp, 'HyperFOAM'));

  const tracks = elem(ID.Tracks,
    elem(ID.TrackEntry,
      uintElem(ID.TrackNumber, 1),
      uintElem(ID.TrackUID, 1),
      uintElem(ID.TrackType, 1),               // 1 = video
      elem(ID.FlagLacing, u8([0])),
      strElem(ID.CodecID, 'V_VP9'),
      uintElem(ID.DefaultDuration, Math.round(1e9 / fps)),   // nanoseconds
      elem(ID.Video,
        uintElem(ID.PixelWidth, width),
        uintElem(ID.PixelHeight, height))));

  /* One cluster per keyframe. Block timestamps are a SIGNED 16-BIT offset from
   * the cluster's own timestamp, so a cluster cannot span more than ~32.7 s;
   * starting a new one at each keyframe keeps that comfortable and gives the
   * Cues something to point at. */
  const clusters = [];
  const cuePoints = [];
  let i = 0;
  while (i < chunks.length) {
    const startTs = times[i];
    const blocks = [];
    do {
      blocks.push(simpleBlock(1, times[i] - startTs, chunks[i].keyframe, chunks[i].data));
      i++;
    } while (i < chunks.length && !chunks[i].keyframe);
    clusters.push({ ts: startTs, bytes: elem(ID.Cluster, uintElem(ID.Timestamp, startTs), ...blocks) });
  }

  // Cue positions are byte offsets from the start of the Segment's payload.
  let at = info.length + tracks.length;
  for (const c of clusters) {
    cuePoints.push(elem(ID.CuePoint,
      uintElem(ID.CueTime, c.ts),
      elem(ID.CueTrackPositions,
        uintElem(ID.CueTrack, 1),
        uintElem(ID.CueClusterPosition, at))));
    at += c.bytes.length;
  }
  const cues = elem(ID.Cues, ...cuePoints);

  const segment = elem(ID.Segment, info, tracks, ...clusters.map(c => c.bytes), cues);
  return new Blob([header, segment], { type: 'video/webm' });
}

/* Exported for tests: walk the top-level elements of an EBML buffer. */
export function ebmlElements(bytes, offset = 0, end = bytes.length) {
  const out = [];
  let o = offset;
  while (o < end) {
    const idStart = o;
    const first = bytes[o];
    if (first === undefined) break;
    let idLen = 1;
    for (let m = 0x80; m > 0 && !(first & m); m >>= 1) idLen++;
    if (idLen > 4) break;
    o += idLen;
    const sFirst = bytes[o];
    if (sFirst === undefined) break;
    let sLen = 1;
    for (let m = 0x80; m > 0 && !(sFirst & m); m >>= 1) sLen++;
    if (sLen > 8) break;
    let size = sFirst & (0xff >> sLen);
    for (let k = 1; k < sLen; k++) size = size * 256 + bytes[o + k];
    o += sLen;
    const id = [...bytes.subarray(idStart, idStart + idLen)]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    out.push({ id, size, dataStart: o, end: o + size });
    o += size;
  }
  return out;
}
