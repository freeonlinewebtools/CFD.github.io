/* WebM (Matroska) container structure.
 *
 * Same discipline as mp4.mjs: assert the element tree, because the failure this
 * replaces produced bytes that were individually fine and collectively
 * unplayable. `tests/webm-play.py` completes it by making Chrome decode a real
 * capture; these run without a browser.
 */
const { muxWebM, ebmlElements } = await import('../src/webm.js');

let pass = 0, fail = 0;
const ok = (cond, msg, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`); }
  else { fail++; console.log(`  FAIL  ${msg}${detail ? '  <- ' + detail : ''}`); }
};
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());

function fakeChunks(n, keyEvery = 30) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ data: new Uint8Array(48 + (i % 7)).fill(i & 255), keyframe: i % keyEvery === 0 });
  }
  return out;
}
const find = (els, id) => els.find(e => e.id === id);
const kids = (buf, e) => ebmlElements(buf, e.dataStart, e.end);

console.log('=== 1. Top-level EBML structure ===');
{
  const buf = await bytes(muxWebM({ chunks: fakeChunks(90), width: 640, height: 480, fps: 30 }));
  const top = ebmlElements(buf);
  console.log(`    top-level: ${top.map(e => e.id).join(' ')}`);
  ok(top.length === 2, 'exactly two top-level elements');
  ok(top[0].id === '1a45dfa3', 'starts with an EBML header');
  ok(top[1].id === '18538067', 'followed by a Segment');
  ok(top[1].end === buf.length, 'the Segment covers the rest of the file exactly',
    `${top[1].end} vs ${buf.length}`);

  // The doctype is what tells a demuxer this is WebM and not plain Matroska.
  const hdr = kids(buf, top[0]);
  const doc = find(hdr, '4282');
  const docStr = String.fromCharCode(...buf.subarray(doc.dataStart, doc.end));
  ok(docStr === 'webm', 'doctype is "webm"', docStr);
}

console.log('\n=== 2. The Segment carries what a player needs ===');
{
  const buf = await bytes(muxWebM({ chunks: fakeChunks(90), width: 640, height: 480, fps: 30 }));
  const seg = ebmlElements(buf)[1];
  const inSeg = kids(buf, seg);
  const ids = inSeg.map(e => e.id);
  console.log(`    segment: ${ids.join(' ')}`);
  ok(ids.includes('1549a966'), 'Segment has Info');
  ok(ids.includes('1654ae6b'), 'Segment has Tracks');
  ok(ids.includes('1f43b675'), 'Segment has at least one Cluster');
  ok(ids.includes('1c53bb6b'), 'Segment has Cues for seeking');

  const track = kids(buf, find(kids(buf, find(inSeg, '1654ae6b')), 'ae'));
  const tIds = track.map(e => e.id);
  ok(tIds.includes('d7') && tIds.includes('83') && tIds.includes('86'),
    'TrackEntry declares number, type and codec');
  const codec = find(track, '86');
  const codecStr = String.fromCharCode(...buf.subarray(codec.dataStart, codec.end));
  ok(codecStr === 'V_VP9', 'codec is V_VP9', codecStr);

  const video = find(track, 'e0');
  const vIds = kids(buf, video).map(e => e.id);
  ok(vIds.includes('b0') && vIds.includes('ba'), 'Video declares pixel dimensions');
}

console.log('\n=== 3. Clusters split on keyframes ===');
/* Block timestamps are a signed 16-bit offset from the cluster timestamp, so a
 * single cluster spanning the whole file would overflow past ~32.7 s. */
{
  const buf = await bytes(muxWebM({ chunks: fakeChunks(180, 30), width: 320, height: 240, fps: 30 }));
  const seg = ebmlElements(buf)[1];
  const clusters = kids(buf, seg).filter(e => e.id === '1f43b675');
  console.log(`    ${clusters.length} clusters for 180 frames, keyframe every 30`);
  ok(clusters.length === 6, 'one cluster per keyframe', String(clusters.length));

  let blocks = 0;
  for (const c of clusters) blocks += kids(buf, c).filter(e => e.id === 'a3').length;
  ok(blocks === 180, 'every frame is present as a SimpleBlock', String(blocks));

  // No block offset may leave int16 range.
  let worst = 0;
  for (const c of clusters) {
    for (const b of kids(buf, c).filter(e => e.id === 'a3')) {
      const dv = new DataView(buf.buffer, buf.byteOffset + b.dataStart + 1, 2);
      worst = Math.max(worst, Math.abs(dv.getInt16(0)));
    }
  }
  ok(worst <= 32767, 'block timestamps stay inside int16', String(worst));
}

console.log('\n=== 4. Timing does not drift ===');
/* Frame times are computed from the index, not accumulated — at 30 fps an
 * accumulated 33 ms would lose a third of a second over five minutes. */
{
  for (const [fps, n] of [[30, 900], [24, 720], [60, 1800]]) {
    const buf = await bytes(muxWebM({ chunks: fakeChunks(n, 60), width: 320, height: 240, fps }));
    const seg = ebmlElements(buf)[1];
    const clusters = kids(buf, seg).filter(e => e.id === '1f43b675');
    const last = clusters[clusters.length - 1];
    const ts = find(kids(buf, last), 'e7');
    let clusterTs = 0;
    for (let i = ts.dataStart; i < ts.end; i++) clusterTs = clusterTs * 256 + buf[i];
    const blocks = kids(buf, last).filter(e => e.id === 'a3');
    const lastBlock = blocks[blocks.length - 1];
    const rel = new DataView(buf.buffer, buf.byteOffset + lastBlock.dataStart + 1, 2).getInt16(0);
    const endMs = clusterTs + rel;
    const wantMs = Math.round((n - 1) * 1000 / fps);
    ok(Math.abs(endMs - wantMs) <= 1, `${fps} fps x ${n}: last frame lands at ${wantMs} ms`,
      `${endMs} ms`);
  }
}

console.log('\n=== 5. Refuses to produce an empty file ===');
{
  let threw = false;
  try { muxWebM({ chunks: [], width: 320, height: 240, fps: 30 }); } catch { threw = true; }
  ok(threw, 'throws when there are no frames');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
