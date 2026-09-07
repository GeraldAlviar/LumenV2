import test from 'node:test';
import assert from 'node:assert/strict';
import { Sensor } from '../js/sensor.js?v=2.2.0';
const sensor = () => { const s = new Sensor({}, { getContext: () => ({}) }); s.running = true; return s; };
function frame(s, ratio = [0.3, 0.3, 0.3]) {
  s.dispatchEvent(new CustomEvent('frame', { detail: {
    ratio, lumaRatio: ratio.reduce((a, b) => a + b) / 3, ts: performance.now(),
    clipping: 0, noise: 0.01, anchor: { linear: [0.5, 0.5, 0.5], luma: 0.5 },
    test: { linear: [0.15, 0.15, 0.15], luma: 0.15 },
  } }));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('no camera frames rejects on a wall-clock deadline', async () => {
  const s = sensor(); await assert.rejects(s.measure({ settleMs: 0, maxMs: 30, minSamples: 3 }), /stalled/);
  assert.equal(s._collecting, false);
});
test('one frame then a camera stall also rejects, rather than hanging', async () => {
  const s = sensor(), p = s.measure({ settleMs: 0, maxMs: 40, minSamples: 3 }); frame(s);
  await assert.rejects(p, /1 of 3/); assert.equal(s._collecting, false);
});
test('measurement stops immediately when cancelled during settling', async () => {
  const s = sensor(), c = new AbortController();
  const p = s.measure({ settleMs: 10000, signal: c.signal }); c.abort();
  await assert.rejects(p, { name: 'AbortError' }); assert.equal(s._collecting, false);
});
test('stopping the camera rejects an in-flight measurement', async () => {
  const s = sensor(), p = s.measure({ settleMs: 0 }); s.stop(); await assert.rejects(p, /stopped/);
});
test('stable per-channel samples converge and release the collection lock', async () => {
  const s = sensor(), p = s.measure({ settleMs: 0, minSamples: 3, maxMs: 100 });
  frame(s); await wait(2); frame(s); await wait(2); frame(s);
  const result = await p; assert.equal(result.converged, true); assert.equal(result.samples, 3); assert.equal(s._collecting, false);
});
test('channel oscillations are not hidden by stable aggregate luminance', async () => {
  const s = sensor(), p = s.measure({ settleMs: 0, minSamples: 4, maxMs: 60 });
  for (let i = 0; i < 6; i++) { frame(s, i % 2 ? [0.2, 0.4, 0.3] : [0.4, 0.2, 0.3]); await wait(2); }
  const result = await p; assert.equal(result.converged, false); assert.ok(result.stability > 0.1);
});
test('concurrent camera consumers are rejected', async () => {
  const s = sensor(), c = new AbortController(), p = s.measure({ signal: c.signal });
  await assert.rejects(s.measure(), /already active/); c.abort(); await assert.rejects(p);
});
test('modulation scan can be cancelled even before the first frame', async () => {
  const s = sensor(), c = new AbortController(), p = s.flickerScan(10000, { signal: c.signal });
  c.abort(); await assert.rejects(p, { name: 'AbortError' }); assert.equal(s._collecting, false);
});
test('failed camera constraints do not claim successful locks', async () => {
  const s = sensor(); s.caps = { exposureMode: ['manual'], whiteBalanceMode: ['manual'] };
  s.track = { applyConstraints: async () => { throw new Error('Unsupported'); }, getSettings: () => ({}) };
  assert.deepEqual(await s.lockCamera(), { exposure: false, whiteBalance: false, focus: false });
});
test('silently ignored camera constraints also remain unconfirmed', async () => {
  const s = sensor(); s.caps = { exposureMode: ['manual'] };
  s.track = { applyConstraints: async () => {}, getSettings: () => ({ exposureMode: 'continuous' }) };
  assert.equal((await s.lockCamera()).exposure, false);
});
test('confirmed manual modes are recognised', async () => {
  const s = sensor(); s.caps = { exposureMode: ['manual'] }; let settings = { exposureMode: 'continuous', exposureTime: 100 };
  s.track = { applyConstraints: async () => { settings.exposureMode = 'manual'; }, getSettings: () => settings };
  assert.equal((await s.lockCamera()).exposure, true);
});
test('uniformity refuses stale frames and unusable centre samples', () => {
  const s = sensor(); assert.throws(() => s.uniformityGrid(), /recent/);
  s.lastFrame = { ts: performance.now() }; s.canvas.width = 480; s.canvas.height = 270;
  s._sampleRegion = () => ({ luma: 0, linear: [0, 0, 0], clipping: 0 });
  assert.throws(() => s.uniformityGrid(), /too dark/);
});
test('uniformity uses explicit screen bounds and produces 25 finite cells', () => {
  const s = sensor(); s.lastFrame = { ts: performance.now() }; s.canvas.width = 480; s.canvas.height = 270;
  const positions = []; s._sampleRegion = r => { positions.push(r); return { luma: 0.3, linear: [0.3, 0.3, 0.3], clipping: 0 }; };
  const u = s.uniformityGrid(5, 5, { x: 0.2, y: 0.2, w: 0.6, h: 0.6 });
  assert.equal(u.cells.length, 25); assert.equal(u.worstDeviation, 0); assert.equal(u.spread, 0);
  assert.ok(positions.every(p => p.x > 0.2 && p.x < 0.8 && p.y > 0.2 && p.y < 0.8));
});
