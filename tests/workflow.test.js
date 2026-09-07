import test from 'node:test';
import assert from 'node:assert/strict';
import { TestRunner } from '../js/runner.js?v=2.2.0';
import { MODES, verifyResume, patchKey, PLAN_VERSION } from '../js/modes.js?v=2.2.0';
import { syntheticReadings } from '../js/demo.js?v=2.2.0';
import { createSession, parseSession } from '../js/session.js?v=2.2.0';
import { SessionStore } from '../js/storage.js?v=2.2.0';
import { withDeadline, delay } from '../js/async.js?v=2.2.0';
import { validMessage, validateResults } from '../js/validation.js?v=2.2.0';
import { squareGuide, sampleRegions, project, validQuad, detectSquare, alignmentAdvice, movementAmount } from '../js/alignment.js?v=2.2.0';
import { makeReport } from '../js/report.js?v=2.2.0';
import { MotionGuard } from '../js/motion.js?v=2.2.0';

const quick = MODES.quick;
const originalTiming = { ...quick.sample };
// Exercise production orchestration with accelerated waits, not rewritten logic.
test.before(() => { quick.sample.settleMs = 0; quick.sample.maxMs = 25; });
test.after(() => { Object.assign(quick.sample, originalTiming); });
function fixture(overrides = {}) {
  const statuses = [], saves = [], checkpoints = [], failures = [], renders = [];
  const baseline = { ratio: [2, 2, 2], anchorLinear: [.2, .2, .2] };
  const io = {
    begin: async () => {}, preflight: async () => baseline,
    render: async patch => { renders.push(patch); },
    measure: async () => syntheticReadings([renders.at(-1)])[0].result,
    save: async data => { saves.push(createSession(data)); return { saved: true }; },
    checkpoint: async data => { checkpoints.push(createSession(data)); },
    notify: status => statuses.push({ ...status }),
    failure: reason => failures.push(reason),
    ...overrides,
  };
  const runner = new TestRunner(io, { deadlines: { begin: 35, preflight: 35, render: 35, measureExtra: 10, checkpoint: 35, diagnostics: 35, retry: 1 } });
  return { io, runner, statuses, saves, checkpoints, failures, renders };
}
function savedQuick(count) {
  return createSession({ readings: syntheticReadings(quick.build().slice(0, count)), target: 'gamma22', run: 'quick', planVersion: PLAN_VERSION,
    sessionId: 'resume-fixture', expected: quick.build().length, complete: false, telemetry: {}, omissions: {} });
}
test('all four modes have distinct plans, increasing coverage and bounded sample windows', () => {
  let previous = 0;
  for (const m of Object.values(MODES)) {
    const p = m.build(); assert.ok(p.length > previous && p.length <= 512); previous = p.length;
    assert.ok(p.some(v => v.kind === 'grey' && v.level === 0)); assert.ok(p.some(v => v.kind === 'grey' && v.level === 1));
    validateResults({ run: m.id, target: 'gamma22', readings: syntheticReadings(p) });
  }
  assert.equal(MODES.quick.uniformity, false); assert.equal(MODES.detailed.uniformity, 3); assert.equal(MODES.full.uniformity, 5);
});
test('a complete quick run saves every valid patch before receiving its acknowledgement', async () => {
  const f = fixture(); assert.equal(await f.runner.start({ run: 'quick' }), true);
  assert.equal(f.runner.session.readings.length, quick.build().length); assert.equal(f.runner.session.complete, true);
  assert.equal(f.runner.busy, false); assert.equal(f.statuses.at(-1).phase, 'complete');
  assert.equal(f.checkpoints.length, quick.build().length + 1);
  assert.ok(f.statuses.every(validMessage));
  assert.ok(f.statuses.some(v => v.phase === 'sampling'));
});
test('zero-reading camera failure is sent as a visible paused state, not silent idle', async () => {
  const f = fixture({ measure: async () => { throw new Error('Camera stalled: 0 frames'); } });
  assert.equal(await f.runner.start({ run: 'quick' }), false);
  assert.equal(f.runner.session.readings.length, 0);
  assert.equal(f.runner.session.telemetry.retries, 2);
  assert.equal(f.statuses.at(-1).phase, 'paused'); assert.match(f.statuses.at(-1).label, /Camera stalled/);
  assert.equal(f.saves.at(-1).readings.length, 0); assert.equal(f.runner.busy, false);
});
test('missing start acknowledgement times out and aborts the pending handshake', async () => {
  let signal;
  const f = fixture({ begin: async (_data, s) => { signal = s; await new Promise(() => {}); } });
  assert.equal(await f.runner.start({ run: 'quick' }), false);
  assert.equal(signal.aborted, true); assert.match(f.failures[0], /acknowledge/); assert.equal(f.runner.busy, false);
});
test('missing camera frames trigger bounded automatic retries and a recoverable pause', async () => {
  const signals = [];
  const f = fixture({ measure: async ({ signal }) => { signals.push(signal); await new Promise(() => {}); } });
  assert.equal(await f.runner.start({ run: 'quick' }), false);
  assert.equal(signals.length, 3); assert.ok(signals.every(v => v.aborted));
  assert.equal(f.runner.session.phase, 'paused'); assert.equal(f.runner.session.complete, false);
});
test('one transient measurement error retries only that patch, with no duplicate reading', async () => {
  let attempts = 0; const f = fixture(); const measure = f.io.measure;
  f.io.measure = async o => { if (++attempts === 1) throw new Error('Transient'); return measure(o); };
  await f.runner.start({ run: 'quick' });
  assert.equal(f.runner.session.telemetry.retries, 1); assert.equal(f.renders.length, quick.build().length + 1);
  assert.deepEqual(f.runner.session.readings.map(r => patchKey(r.patch)), quick.build().map(patchKey));
});
test('clipped samples are rejected, never counted as completed measurements', async () => {
  const f = fixture(); const measure = f.io.measure;
  f.io.measure = async () => ({ ...await measure(), clipping: .5 });
  await f.runner.start({ run: 'quick' });
  assert.equal(f.runner.session.readings.length, 0); assert.equal(f.runner.session.telemetry.clipping, 3);
  assert.match(f.runner.session.reason, /clipped|overexposed/);
});
test('pausing aborts acquisition, prevents duplicate starts, and retains prior samples', async () => {
  const f = fixture(); const first = f.runner.start({ run: 'quick' });
  assert.equal(await f.runner.start({ run: 'quick' }), false);
  f.runner.addEventListener('status', e => { if (e.detail.phase === 'sampling') f.runner.pause('Phone moved', 'movements'); });
  assert.equal(await first, false); assert.equal(f.runner.session.telemetry.movements, 1);
  assert.equal(f.runner.phase, 'paused'); assert.equal(f.runner.busy, false);
});
test('a lost checkpoint acknowledgement preserves the valid reading for a safe resume', async () => {
  let calls = 0; const f = fixture({ checkpoint: async () => { if (++calls === 1) throw new Error('Disconnected'); } });
  assert.equal(await f.runner.start({ run: 'quick' }), false); assert.equal(f.runner.session.readings.length, 1);
  assert.equal(f.saves.at(-1).readings.length, 1);
  assert.equal(await f.runner.start({ resume: true }), true);
  assert.equal(f.runner.session.readings.length, quick.build().length);
  assert.equal(f.runner.session.telemetry.resumes, 1);
  assert.deepEqual(f.runner.session.readings.map(r => patchKey(r.patch)), quick.build().map(patchKey));
});
test('resuming a saved test begins at its first missing patch, not zero', async () => {
  const f = fixture(); f.runner.restore(savedQuick(5));
  await f.runner.start({ resume: true });
  assert.equal(patchKey(f.renders[0]), patchKey(quick.build()[5])); assert.equal(f.runner.session.complete, true);
});
test('altered, finished and mismatched test plans cannot be silently resumed', () => {
  const saved = savedQuick(2); saved.readings[0].patch.test = [.7, .7, .7]; assert.throws(() => verifyResume(saved), /match/);
  assert.throws(() => verifyResume({ ...savedQuick(0), planVersion: 99 }), /cannot be resumed/);
  assert.throws(() => verifyResume({ ...savedQuick(0), complete: true }), /cannot be resumed/);
});
test('completion sync failure retains the finished session instead of losing results', async () => {
  const f = fixture({ checkpoint: async session => { if (session.complete) throw new Error('Report sync lost'); } });
  assert.equal(await f.runner.start({ run: 'quick' }), false);
  assert.equal(f.runner.session.complete, true); assert.equal(f.runner.phase, 'complete');
  assert.match(f.runner.session.reason, /sync/); assert.equal(f.saves.at(-1).complete, true);
});
test('unavailable diagnostics can be reported as omissions without inventing measurements', async () => {
  const f = fixture({ diagnostics: async session => { session.omissions.uniformity = 'Display-field corners not visible'; } });
  await f.runner.start({ run: 'quick' }); const report = makeReport(f.runner.session);
  assert.equal(report.coverage.find(c => c.name === 'Field uniformity').measured, false);
  assert.match(report.coverage.find(c => c.name === 'Field uniformity').note, /not visible/);
});
test('saved snapshots are detached from a running test', () => {
  const source = savedQuick(1), copy = createSession(source);
  source.readings.push(source.readings[0]); source.readings[0].result.ratio[0] = 999;
  assert.equal(copy.readings.length, 1); assert.notEqual(copy.readings[0].result.ratio[0], 999);
});
test('version two sessions round-trip and version one reports still open', () => {
  const saved = savedQuick(1); assert.deepEqual(parseSession(JSON.stringify(saved)), saved);
  const old = { ...saved, version: 1 }; assert.equal(parseSession(JSON.stringify(old)).version, 2);
});
test('denied IndexedDB and localStorage become memory-only, not a blocked test', async () => {
  const store = new SessionStore('phone', { localStorage: { setItem() { throw new Error('Denied'); }, getItem() { throw new Error('Denied'); } } });
  assert.equal((await store.save(savedQuick(0))).saved, false); assert.equal(await store.load(), null);
});
test('localStorage fallback saves and recovers the exact last step', async () => {
  const data = new Map(); const storage = { setItem: (k,v) => data.set(k,v), getItem: k => data.get(k) || null, removeItem: k => data.delete(k) };
  const store = new SessionStore('phone', { localStorage: storage });
  assert.equal((await store.save(savedQuick(3))).backend, 'localStorage fallback');
  assert.equal((await store.load()).readings.length, 3); assert.equal(await store.clear(), true); assert.equal(await store.load(), null);
});
test('deadlines abort their task, and cancellation prevents work starting', async () => {
  let inner; await assert.rejects(withDeadline(async signal => { inner = signal; await new Promise(() => {}); }, 5, 'deadline'), /deadline/);
  assert.equal(inner.aborted, true);
  const c = new AbortController(); c.abort('cancelled'); let called = false;
  await assert.rejects(withDeadline(() => { called = true; }, 5, 'deadline', c.signal)); assert.equal(called, false);
});
test('square guide and square samples preserve geometry on portrait and landscape images', () => {
  for (const [w,h] of [[480,640],[640,480]]) {
    const q = squareGuide(w,h); assert.ok(validQuad(q));
    assert.ok(Math.abs((q[1].x-q[0].x)*w-(q[3].y-q[0].y)*h) < 1e-8);
    const regions = sampleRegions(q,w,h); assert.equal(regions.anchor.shape,'square');
    assert.ok(regions.anchor.x < regions.test.x); assert.equal(regions.anchor.y, regions.test.y);
  }
});
test('perspective projection maps all four corners exactly', () => {
  const q = [{x:.18,y:.13},{x:.86,y:.24},{x:.72,y:.91},{x:.08,y:.78}];
  for (const [i,[u,v]] of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]]]) {
    const p = project(q,u,v); assert.ok(Math.hypot(p.x-q[i].x,p.y-q[i].y)<1e-9);
  }
});
test('marker detector finds four coloured corners but rejects an empty image', () => {
  const w=240,h=180,data=new Uint8ClampedArray(w*h*4);
  const spots=[[60,30,[188,0,188]],[180,30,[0,188,188]],[180,150,[0,188,188]],[60,150,[0,188,188]]];
  for(const [cx,cy,rgb] of spots) for(let y=cy-3;y<=cy+3;y++) for(let x=cx-3;x<=cx+3;x++) data.set([...rgb,255],(y*w+x)*4);
  const q=detectSquare({width:w,height:h,data}); assert.ok(q); assert.ok(validQuad(q)); assert.ok(Math.abs(q[0].x-.25)<.01);
  assert.equal(detectSquare({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),null);
});
test('alignment advice allows a manual lock rather than claiming detection', () => {
  const q=squareGuide(480,640); assert.equal(alignmentAdvice(null,q,480,640).grade,'Manual');
  assert.equal(alignmentAdvice(q,q,480,640).grade,'Excellent');
  assert.equal(movementAmount(q,q,480,640),0);
  assert.ok(movementAmount(q,q.map(p=>({x:p.x+.04,y:p.y})),480,640)>.04);
});
test('motion guard respects permission denial and requires sustained movement', async () => {
  const host=new EventTarget(); host.DeviceMotionEvent={requestPermission:async()=> 'denied'};
  const guard=new MotionGuard(host); assert.equal(await guard.enable(),false);
  host.DeviceMotionEvent.requestPermission=async()=> 'granted'; assert.equal(await guard.enable(),true);
  let n=0;guard.addEventListener('movement',()=>n++);guard.arm();
  for(let i=0;i<3;i++){const e=new Event('devicemotion');e.rotationRate={alpha:20};host.dispatchEvent(e);}
  assert.equal(n,1);assert.equal(guard.armed,false);guard.destroy();
});
test('report quality does not pretend automatic exposure is a confirmed camera lock', () => {
  const saved=savedQuick(quick.build().length);saved.complete=true;saved.telemetry={exposureLocked:false,whiteBalanceLocked:false};
  const r=makeReport(saved);assert.equal(r.grade,'Fair');assert.ok(r.quality.warnings.some(w=>w.includes('not confirmed')));
  assert.equal(r.coverage.find(c=>c.name==='Colour response').measured,false);
  assert.match(r.coverage.find(c=>c.name==='Colour response').note,/Quick Check/);
});
test('render validation rejects invalid fields, anchors and session identifiers', () => {
  assert.ok(validMessage({t:'render',layout:'alignment',test:[.5,.5,.5],anchor:.5}));
  assert.equal(validMessage({t:'render',layout:'alignment',test:[.5,.5,.5],anchor:'bad'}),false);
  assert.equal(validMessage({t:'render',test:[.5,.5,.5],anchor:.5,sessionId:{}}),false);
});
