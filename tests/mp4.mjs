/* MP4 container structure.
 *
 * The bug this guards against is specific and was shipped: valid H.264 written
 * into a .mp4 with no boxes around it. The file looked plausible — right
 * extension, right bytes, right size — and no player would open it. Structure
 * is therefore what gets asserted, box by box, not just "output exists".
 *
 * `tests/mp4-play.py` completes this by decoding a real capture in Chrome;
 * these checks run without a browser.
 */
const { muxMP4, topLevelBoxes } = await import('../src/mp4.js');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? '  <- ' + detail : ''}`); }
};

// Node has no Blob-to-bytes shortcut in older versions; go through arrayBuffer.
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

/* A plausible AVCDecoderConfigurationRecord. The muxer copies it verbatim, so
 * the exact contents do not matter — only that it lands inside avcC. */
const AVCC = new Uint8Array([
  1, 0x42, 0x00, 0x1e, 0xff,
  0xe1, 0x00, 0x09, 0x67, 0x42, 0x00, 0x1e, 0x8d, 0x8d, 0x40, 0xa0, 0xfd,
  0x01, 0x00, 0x04, 0x68, 0xce, 0x3c, 0x80,
]);

function fakeChunks(n, fps = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      data: new Uint8Array(64 + i).fill(i & 255),
      keyframe: i % 30 === 0,
      duration: Math.round(1e6 / fps),
    });
  }
  return out;
}

const find = (boxes, type) => boxes.find(b => b.type === type);
/* A box's payload, as its own buffer. Offsets from topLevelBoxes are relative
 * to the buffer they were read from, so descending has to slice at each step
 * rather than accumulate offsets against the original file. */
const payloadOf = (buf, b) => buf.subarray(b.offset + b.header, b.offset + b.size);
/* Descend a path like 'moov/trak/mdia', returning that box's payload. */
function descend(buf, path) {
  let cur = buf;
  for (const want of path.split('/')) {
    const b = find(topLevelBoxes(cur), want);
    if (!b) throw new Error(`no ${want} in path ${path}`);
    cur = payloadOf(cur, b);
  }
  return cur;
}
const typesIn = buf => topLevelBoxes(buf).map(b => b.type);
/* Does `needle` appear anywhere in the buffer? */
const contains = (hay, needle) => {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

console.log('=== 1. Top-level structure ===');
{
  const chunks = fakeChunks(90);
  const buf = await bytes(muxMP4({ chunks, description: AVCC, width: 640, height: 480, fps: 30 }));
  const boxes = topLevelBoxes(buf);
  console.log(`    boxes: ${boxes.map(b => `${b.type}(${b.size})`).join(' ')}`);
  ok(boxes.length === 3, 'exactly three top-level boxes');
  ok(boxes[0].type === 'ftyp', 'starts with ftyp');
  ok(boxes[1].type === 'mdat', 'then mdat');
  ok(boxes[2].type === 'moov', 'then moov');
  // Sizes must tile the file exactly, or a demuxer walking them falls off.
  const total = boxes.reduce((a, b) => a + b.size, 0);
  ok(total === buf.length, 'box sizes tile the file exactly', `${total} vs ${buf.length}`);

  const payload = chunks.reduce((a, c) => a + c.data.length, 0);
  ok(boxes[1].size === payload + 8, 'mdat size covers every sample byte');
}

console.log('\n=== 2. The moov index is complete ===');
{
  const buf = await bytes(muxMP4({ chunks: fakeChunks(90), description: AVCC, width: 640, height: 480, fps: 30 }));
  const moovK = typesIn(descend(buf, 'moov'));
  console.log(`    moov: ${moovK.join(' ')}`);
  ok(moovK.includes('mvhd'), 'moov has mvhd');
  ok(moovK.includes('trak'), 'moov has trak');

  const trakK = typesIn(descend(buf, 'moov/trak'));
  ok(trakK.includes('tkhd'), 'trak has tkhd');
  ok(trakK.includes('mdia'), 'trak has mdia');

  const mdiaK = typesIn(descend(buf, 'moov/trak/mdia'));
  ok(mdiaK.includes('mdhd') && mdiaK.includes('hdlr'), 'mdia has mdhd and hdlr');

  const minfK = typesIn(descend(buf, 'moov/trak/mdia/minf'));
  ok(minfK.includes('vmhd') && minfK.includes('dinf'), 'minf has vmhd and dinf');

  const got = typesIn(descend(buf, 'moov/trak/mdia/minf/stbl'));
  console.log(`    stbl: ${got.join(' ')}`);
  for (const need of ['stsd', 'stts', 'stss', 'stsc', 'stsz', 'stco']) {
    ok(got.includes(need), `stbl has ${need}`);
  }
}

console.log('\n=== 3. The codec record survives into avcC ===');
{
  const buf = await bytes(muxMP4({ chunks: fakeChunks(30), description: AVCC, width: 320, height: 240, fps: 30 }));
  ok(contains(buf, AVCC), 'the avcC payload is present verbatim');
  ok(contains(buf, new Uint8Array([0x61, 0x76, 0x63, 0x43])), "an 'avcC' box exists");
  ok(contains(buf, new Uint8Array([0x61, 0x76, 0x63, 0x31])), "an 'avc1' sample entry exists");
}

console.log('\n=== 4. Sample offsets point at real data ===');
/* stco is where a demuxer starts reading. Off by a byte and every frame is
 * garbage, which is precisely the failure mode that is hard to eyeball. */
{
  const chunks = fakeChunks(10);
  const buf = await bytes(muxMP4({ chunks, description: AVCC, width: 320, height: 240, fps: 30 }));
  const boxes = topLevelBoxes(buf);
  const mdat = find(boxes, 'mdat');
  const dataStart = mdat.offset + mdat.header;

  const stbl = descend(buf, 'moov/trak/mdia/minf/stbl');
  const stco = find(topLevelBoxes(stbl), 'stco');
  ok(!!stco, 'stco located');
  const body = payloadOf(stbl, stco);               // [1 ver][3 flags][4 count][4 offset]
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  ok(dv.getUint32(4) === 1, 'stco declares a single chunk');
  const offset = dv.getUint32(8);
  console.log(`    stco offset=${offset}, mdat data starts at ${dataStart}`);
  ok(offset === dataStart, 'the chunk offset is the first sample byte');
  ok(buf[offset] === chunks[0].data[0], 'and that byte is the first sample');
}

console.log('\n=== 5. Refuses to produce an unplayable file ===');
/* Silently emitting a container-less .mp4 is what caused the original bug, so
 * the muxer must fail loudly instead — the recorder catches this and falls
 * back to a format that works. */
{
  let threw = false;
  try { muxMP4({ chunks: fakeChunks(4), description: null, width: 320, height: 240, fps: 30 }); }
  catch { threw = true; }
  ok(threw, 'throws when the encoder gave no avcC record');

  threw = false;
  try { muxMP4({ chunks: [], description: AVCC, width: 320, height: 240, fps: 30 }); }
  catch { threw = true; }
  ok(threw, 'throws when there are no frames');
}

console.log('\n=== 6. Timing ===');
{
  for (const fps of [24, 25, 30, 50, 60]) {
    const n = fps * 2;
    const buf = await bytes(muxMP4({
      chunks: fakeChunks(n, fps), description: AVCC, width: 320, height: 240, fps,
    }));
    const moovBuf = descend(buf, 'moov');
    const mvhd = payloadOf(moovBuf, find(topLevelBoxes(moovBuf), 'mvhd'));
    // mvhd v0 payload: [1 ver][3 flags][4 ctime][4 mtime][4 timescale][4 duration]
    const dv = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
    const timescale = dv.getUint32(12);
    const duration = dv.getUint32(16);
    const seconds = duration / timescale;
    ok(Math.abs(seconds - 2) < 0.02, `${fps} fps: duration is 2.00 s`, `${seconds.toFixed(3)} s`);
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
