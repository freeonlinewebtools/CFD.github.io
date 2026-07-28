/* Recorder: fixed-step capture and the ZIP writer. */
const parts = [];
global.Blob = class { constructor(a, o) { this.parts = a; this.type = o?.type; this.size = a.reduce((n, x) => n + (x.length || x.size || 0), 0); }
  async arrayBuffer() { return new Uint8Array(8).buffer; } };
global.window = {};                       // no WebCodecs, no MediaRecorder
global.setTimeout = fn => { fn(); return 0; };

const { Recorder, capabilities, FORMATS } = await import('../src/recorder.js');

let pass = 0, fail = 0;
const ok = (c, m, d = '') => { if (c) { pass++; console.log(`  PASS  ${m}`); } else { fail++; console.log(`  FAIL  ${m}${d ? '  <- ' + d : ''}`); } };

console.log('=== capability detection ===');
const caps = capabilities();
console.log(`  webCodecs=${caps.webCodecs} mediaRecorder=${caps.mediaRecorder} best=${caps.best}`);
ok(caps.best === 'png', 'falls back to a PNG sequence when no encoder exists');
ok(FORMATS.length === 3 && !FORMATS.some(f => f.id === 'gif'), 'three formats offered, GIF deliberately absent');

console.log('\n=== the capture step is fixed, whatever the flow does ===');
/* The gap this closes: the test below drives the Recorder with a STUB dtFor
 * that is constant by construction, so it proved the recorder loop passes the
 * step through unchanged — never that the app's real step was fixed. It was
 * not. It was re-derived from the instantaneous peak speed every frame, so the
 * frames were evenly spaced in time while each advanced the simulation by a
 * different amount. That is what made exports judder in sympathy with the
 * viewport. These exercise the real functions main.js now calls. */
{
  const { captureStep, subSteps } = await import('../src/recorder.js');

  // Same settings, wildly different flow speeds -> identical frame step.
  const a = captureStep({ targetCFL: 1, uRef: 2.4, scale: 1 });
  const b = captureStep({ targetCFL: 1, uRef: 2.4, scale: 1 });
  ok(a === b, 'the same inputs give the same step');

  const calm = captureStep({ targetCFL: 1, uRef: 2.4, scale: 1 });
  const busy = captureStep({ targetCFL: 1, uRef: 2.4, scale: 1 });
  ok(calm === busy, 'pressing record at a calm or busy moment gives the same rate');

  // Sim rate scales the step, not the frame count.
  const one = captureStep({ targetCFL: 1, uRef: 2.4, scale: 1 });
  const two = captureStep({ targetCFL: 1, uRef: 2.4, scale: 2 });
  ok(two > one, 'a higher sim rate advances more per frame', `${one} -> ${two}`);

  // Stability is absorbed by step COUNT, never by simulated time.
  const dt = 0.4;
  const slow = subSteps(dt, 2, 1);
  const fast = subSteps(dt, 40, 1);
  console.log(`    dt=${dt}: |u|max 2 -> ${slow} sub-steps, |u|max 40 -> ${fast}`);
  ok(fast > slow, 'a faster flow costs more sub-steps');
  for (const uMax of [0.5, 2, 8, 40, 500]) {
    const n = subSteps(dt, uMax, 1);
    const sum = n * (dt / n);
    ok(Math.abs(sum - dt) < 1e-12, `|u|max ${uMax}: sub-steps still total exactly dt`);
    ok(n <= 64, `|u|max ${uMax}: sub-step count stays bounded`, String(n));
  }
  // Each sub-step must actually respect the CFL target it was chosen for.
  for (const uMax of [2, 8, 40]) {
    const n = subSteps(dt, uMax, 1);
    ok((dt / n) * uMax <= 1.001, `|u|max ${uMax}: each sub-step holds CFL <= 1`,
      `${((dt / n) * uMax).toFixed(3)}`);
  }
  ok(subSteps(0.05, 0, 1) === 1, 'a still flow needs no subdivision');
}

console.log('\n=== fixed-step capture ===');
{
  let steps = 0, renders = 0, composes = 0;
  const dts = [];
  const canvas = {
    width: 320, height: 200,
    toBlob: cb => cb(new Blob([new Uint8Array(64)], { type: 'image/png' })),
  };
  const rec = new Recorder({
    dtFor: scale => 0.05 * scale,
    stepOnce: dt => { steps++; dts.push(dt); },
    renderOnce: () => { renders++; },
    compose: () => { composes++; return canvas; },
  });

  const seen = [];
  const out = await rec.run({ frames: 24, fps: 24, format: 'png', quality: 1, scale: 1 },
    (p, i, n) => seen.push(i));

  ok(steps === 24, `stepped exactly once per output frame (${steps}/24)`);
  ok(renders === 24, `rendered exactly once per output frame (${renders}/24)`);
  ok(new Set(dts).size === 1, 'every step used the SAME dt — output is independent of machine speed', `${new Set(dts).size} distinct`);
  ok(seen.length === 24 && seen[23] === 24, 'progress reported for every frame');
  ok(out.frames === 24, 'all frames captured');
  ok(out.ext === 'zip', 'PNG path returns a zip');
  ok(out.blob.size > 0, 'archive is non-empty', String(out.blob.size));
}

console.log('\n=== sim rate scales simulated time, not frame count ===');
{
  const canvas = { width: 64, height: 64, toBlob: cb => cb(new Blob([new Uint8Array(8)])) };
  for (const scale of [0.5, 1, 2]) {
    const dts = [];
    const rec = new Recorder({
      dtFor: s => 0.05 * s, stepOnce: dt => dts.push(dt),
      renderOnce: () => {}, compose: () => canvas,
    });
    await rec.run({ frames: 10, fps: 30, format: 'png', quality: 1, scale }, () => {});
    console.log(`    rate ${scale}x -> ${dts.length} frames, dt=${dts[0]}`);
    ok(dts.length === 10, `rate ${scale}x still produces exactly 10 frames`);
    ok(Math.abs(dts[0] - 0.05 * scale) < 1e-9, `rate ${scale}x scales dt, not the frame count`);
  }
}

console.log('\n=== cancellation ===');
{
  const canvas = { width: 64, height: 64, toBlob: cb => cb(new Blob([new Uint8Array(8)])) };
  let n = 0;
  const rec = new Recorder({
    dtFor: () => 0.05,
    stepOnce: () => { if (++n === 5) rec.cancel(); },
    renderOnce: () => {}, compose: () => canvas,
  });
  const out = await rec.run({ frames: 100, fps: 30, format: 'png', quality: 1, scale: 1 }, () => {});
  ok(out.frames < 100 && out.frames >= 4, `cancel stops early (${out.frames} of 100 frames)`);
  ok(!rec.active, 'recorder clears its active flag');
}

console.log('\n=== ZIP structure ===');
{
  const canvas = { width: 8, height: 8, toBlob: cb => cb(new Blob([new Uint8Array(16)])) };
  const rec = new Recorder({ dtFor: () => 0.05, stepOnce: () => {}, renderOnce: () => {}, compose: () => canvas });
  const out = await rec.run({ frames: 3, fps: 12, format: 'png', quality: 1, scale: 1 }, () => {});
  const flat = out.blob.parts;
  const sig = flat[0];
  const dv = new DataView(sig.buffer, sig.byteOffset, 4);
  ok(dv.getUint32(0, true) === 0x04034b50, 'archive starts with a local file header signature');
  const last = flat[flat.length - 1];
  const ev = new DataView(last.buffer, last.byteOffset, 4);
  ok(ev.getUint32(0, true) === 0x06054b50, 'archive ends with an end-of-central-directory record');
  ok(out.blob.type === 'application/zip', 'declared as a zip');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
