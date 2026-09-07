import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureError, captureIssues, blockers, rememberWarnings, referenceDrift } from '../js/capture.js?v=2.2.0';
import { VisualMotionGuard } from '../js/tracking.js?v=2.2.0';
import { MODES, PLAN_VERSION, planFor, verifyResume } from '../js/modes.js?v=2.2.0';
import { syntheticReadings } from '../js/demo.js?v=2.2.0';
import { createSession, parseSession } from '../js/session.js?v=2.2.0';
import { TestRunner } from '../js/runner.js?v=2.2.0';
import { makeReport } from '../js/report.js?v=2.2.0';
import { comparisonBaseline, analyseVerification, compareVerification } from '../js/verification.js?v=2.2.0';
import { validMessage, validateResults } from '../js/validation.js?v=2.2.0';
import { squareGuide, alignmentAdvice, sampleRegions } from '../js/alignment.js?v=2.2.0';
const original = { ...MODES.quick.sample };
test.before(() => Object.assign(MODES.quick.sample, { settleMs: 0, maxMs: 35 }));
test.after(() => Object.assign(MODES.quick.sample, original));
function goodSession(run = 'quick', gamma = 2.2) {
  const plan = planFor(run);
  return createSession({ run, planVersion: PLAN_VERSION, target: 'gamma22', sessionId: 'source', expected: plan.length, readings: syntheticReadings(plan, gamma),
    complete: true, telemetry: { exposureLocked: true, whiteBalanceLocked: true }, alignment: { automatic: true, grade: 'Good' } });
}
function rig(overrides = {}) {
  const statuses = [], saves = []; let lastPatch;
  const io = {
    begin: async () => {}, preflight: async () => ({ ratio: [2,2,2], anchorLinear: [.2,.2,.2] }),
    render: async p => { lastPatch = p; }, measure: async () => syntheticReadings([lastPatch])[0].result,
    save: async s => { saves.push(createSession(s)); return { saved: true }; }, checkpoint: async () => {},
    notify: status => statuses.push(status), ...overrides,
  };
  const runner = new TestRunner(io, { deadlines: { begin: 50, preflight: 50, render: 50, measureExtra: 15, retry: 0, review: 60 } });
  return { io, runner, statuses, saves };
}
test('recoverable capture problems are warnings rather than geometric blockers', () => {
  const r = syntheticReadings(planFor('quick'))[0];
  r.result.converged = false; r.result.clipping = .04; r.result.noise = .2;
  const issues = captureIssues(r);
  assert.ok(issues.length >= 3); assert.equal(blockers(issues).length, 0);
});
test('severe clipping, no signal and malformed data cannot be overridden', () => {
  const r = syntheticReadings(planFor('quick'))[0]; r.result.clipping = .5;
  assert.equal(blockers(captureIssues(r))[0].code, 'clipping-severe');
  r.result.clipping = 0; r.result.anchorLinear = [0,0,0];
  assert.equal(blockers(captureIssues(r))[0].code, 'no-signal');
  assert.equal(blockers(captureIssues({}))[0].code, 'invalid');
});
test('Continue anyway completes a noisy run with no repeated consent traps', async () => {
  const r = rig(); let reviews = 0; const measure = r.io.measure;
  r.io.measure = async () => ({ ...await measure(), converged: false, noise: .22 });
  r.io.review = async () => { reviews++; return 'continue'; };
  assert.equal(await r.runner.start({ run: 'quick' }), true);
  assert.equal(reviews, 1); assert.equal(r.runner.session.capture.diagnosticOnly, true);
  assert.equal(r.runner.session.readings.length, planFor('quick').length);
  assert.equal(r.runner.session.telemetry.retries, 2);
  assert.ok(r.statuses.some(s => s.phase === 'review'));
  assert.equal(makeReport(r.runner.session).quality.canExport, false);
});
test('Retry after a warning retries the same patch rather than duplicating it', async () => {
  const r = rig(); let calls = 0, reviews = 0; const measure = r.io.measure;
  r.io.measure = async () => ({ ...await measure(), converged: ++calls > 3 });
  r.io.review = async () => { reviews++; return 'retry'; };
  assert.equal(await r.runner.start({ run: 'quick' }), true);
  assert.equal(reviews, 1); assert.equal(r.runner.session.capture.diagnosticOnly, false);
  assert.equal(r.runner.session.readings.length, planFor('quick').length);
});
test('Continue from setup survives the measurement quality checks as a diagnostic policy', async () => {
  const r = rig({ preflight: async () => ({ ratio:[2,2,2], anchorLinear:[.2,.2,.2], warnings:[{code:'noise',title:'Noisy capture',detail:'Review this.',severity:'warning'}] }), review: async () => 'continue' });
  const measure = r.io.measure; r.io.measure = async () => ({ ...await measure(), noise: .3 });
  assert.equal(await r.runner.start({run:'quick'}), true);
  assert.equal(r.runner.session.capture.diagnosticOnly, true);
  assert.ok(r.runner.session.capture.warnings.some(w => w.accepted && w.stage === 'setup'));
});
test('diagnostic consent does not bypass severe clipping on later patches', async () => {
  const r = rig(); const measure = r.io.measure; let n = 0;
  r.io.review = async () => 'continue';
  r.io.measure = async () => ({ ...await measure(), clipping: ++n <= 3 ? .04 : .9 });
  assert.equal(await r.runner.start({run:'quick'}), false);
  assert.equal(r.runner.session.readings.length, 1);
  assert.match(r.runner.session.reason, /severely overexposed/);
});
test('warning choice times out visibly and never strands the runner', async () => {
  const r = rig({review: async (_p, signal) => { assert.equal(signal.aborted,false); await new Promise(()=>{}); }});
  const measure=r.io.measure; r.io.measure=async()=>({...await measure(),converged:false});
  assert.equal(await r.runner.start({run:'quick'}),false);
  assert.equal(r.runner.busy,false); assert.match(r.runner.session.reason,/No choice/);
});
test('Stop during a review aborts the review promise and retains prior readings', async () => {
  let reviewSignal;
  const r=rig({review:async (_p,signal)=>{reviewSignal=signal; r.runner.stop(); await new Promise(()=>{});}});
  const measure=r.io.measure;r.io.measure=async()=>({...await measure(),converged:false});
  assert.equal(await r.runner.start({run:'quick'}),false);
  assert.equal(reviewSignal.aborted,true);assert.equal(r.runner.phase,'stopped');assert.equal(r.runner.busy,false);
});
test('warnings and explicit consent survive JSON round trips and checkpoints', () => {
  const data=goodSession();rememberWarnings(data,[{code:'noise',title:'Noise',detail:'Detail'}],'setup',true);
  const copy=parseSession(JSON.stringify(createSession(data)));
  assert.equal(copy.capture.diagnosticOnly,true);assert.equal(copy.capture.warnings[0].accepted,true);
});
test('warning count is bounded and deduplicated without silently undoing consent', () => {
  const data=goodSession();
  for(let i=0;i<200;i++)rememberWarnings(data,[{code:'n'+i,title:'Noise',detail:'Detail'}],'setup',true);
  assert.equal(data.capture.warnings.length,64);assert.equal(data.capture.diagnosticOnly,true);
});
test('unknown camera lock metadata cannot enable correction exports', () => {
  const data=goodSession();data.telemetry={};assert.equal(makeReport(data).quality.canExport,false);
});
test('all clean experimental export requirements are still honoured', () => {
  const data=goodSession();assert.equal(makeReport(data).quality.canExport,true);
  data.capture.diagnosticOnly=true;assert.equal(makeReport(data).quality.canExport,false);
});
test('off-centre geometry is usable without matching the guide', () => {
  const g=squareGuide(640,480,.42),q=g.map(p=>({x:p.x-.18,y:p.y-.14}));
  assert.equal(alignmentAdvice(q,squareGuide(640,480),640,480).grade,'Excellent');
  assert.ok(sampleRegions(q,640,480).anchor.x<.5);
});
test('small motion and momentary marker loss do not pause', () => {
  const guard=new VisualMotionGuard(),q=squareGuide(480,640);guard.reset(0);
  assert.equal(guard.check(q,q.map(p=>({x:p.x+.015,y:p.y})),480,640,200),'steady');
  assert.equal(guard.check(q,null,480,640,2500),'searching');
  assert.equal(guard.check(q,q,480,640,5000),'steady');
});
test('sustained substantial movement and long marker loss do pause', () => {
  const guard=new VisualMotionGuard(),q=squareGuide(480,640),m=q.map(p=>({x:p.x+.1,y:p.y}));guard.reset(0);
  assert.equal(guard.check(q,m,480,640,50),'minor');
  assert.equal(guard.check(q,m,480,640,1200),'moved');
  guard.reset(0);assert.equal(guard.check(q,null,480,640,8100),'lost');
});
test('every mode contains held-out tones, periodic references and no duplicate grey levels', () => {
  for(const m of Object.values(MODES)) {
    const p=m.build(),greys=p.filter(p=>p.kind==='grey');
    assert.equal(new Set(greys.map(p=>p.level)).size,greys.length);
    assert.equal(p.filter(p=>p.kind==='verification').length,4);
    assert.ok(p.filter(p=>p.kind==='reference').length>=3);
    for(const v of p.filter(p=>p.kind==='verification'))assert.ok(!greys.some(g=>g.level===v.level));
  }
});
test('repeated-reference drift triggers a review rather than silent compensation', async () => {
  const r=rig();let current,refs=0,reviewed=0;
  r.io.render=async p=>{current=p;};
  r.io.measure=async()=>{const result=syntheticReadings([current])[0].result;if(current.kind==='reference'&&++refs>1)result.ratio=result.ratio.map(v=>v*1.2);return result;};
  r.io.review=async ({issues})=>{assert.ok(issues.some(i=>i.code==='reference-drift'));reviewed++;return 'continue';};
  assert.equal(await r.runner.start({run:'quick'}),true);
  assert.equal(reviewed,1);assert.ok(r.runner.session.telemetry.referenceDrift>.19);
  assert.equal(makeReport(r.runner.session).quality.canExport,false);
});
test('reference drift detects ratio change, not arbitrary labels',()=>{
  assert.ok(Math.abs(referenceDrift({ratio:[2.2,2,2]},{ratio:[2,2,2]})-.1)<1e-9);
});
test('held-out validation measures actual values and does not report an assumed success', () => {
  const worse=goodSession('standard',2.7),better=goodSession('standard',2.2);
  assert.ok(analyseVerification(worse).meanAbsError>analyseVerification(better).meanAbsError);
  const result=compareVerification(comparisonBaseline(worse),better);
  assert.equal(result.status,'Apparent tone error decreased');assert.equal(result.reliable,true);
});
test('verification comparisons with unlocked cameras are labelled low-confidence', () => {
  const before=goodSession(),after=goodSession();after.telemetry.exposureLocked=false;
  const result=compareVerification(comparisonBaseline(before),after);
  assert.equal(result.reliable,false);assert.match(result.message,/Low-confidence/);
});
test('post-adjustment check is a new plan and never merges baseline readings',async()=>{
  const before=goodSession(),comparison=comparisonBaseline(before,'monitor','Gamma preset changed');
  const r=rig();assert.equal(await r.runner.start({run:'quick',comparison}),true);
  assert.equal(r.runner.session.purpose,'verification');assert.notEqual(r.runner.session.sessionId,before.sessionId);
  assert.equal(r.runner.session.readings.length,planFor('quick','verification').length);
  assert.equal(r.runner.session.readings.filter(r=>r.patch.kind==='grey').length,2);
  assert.equal(makeReport(r.runner.session).quality.canExport,false);
  assert.equal(r.runner.session.comparison.sourceSessionId,before.sessionId);
});
test('demo, incomplete and missing verification baselines cannot masquerade as a real comparison',()=>{
  const a=goodSession();a.synthetic=true;assert.throws(()=>comparisonBaseline(a),/real test/);
  a.synthetic=false;a.complete=false;assert.throws(()=>comparisonBaseline(a));
});
test('unsupported or poisoned comparison and warning metadata is rejected on import',()=>{
  const a=goodSession();a.capture={diagnosticOnly:'yes',warnings:[]};assert.throws(()=>validateResults(a));
  const b=goodSession();b.comparison=comparisonBaseline(b);b.comparison.before.points[0].error=Infinity;assert.throws(()=>validateResults(b));
  assert.equal(validMessage({t:'run-start',run:'quick',target:'gamma22',expected:18,sessionId:'x',purpose:'forged'}),false);
});
test('older complete reports can open but old plans cannot resume across a release',()=>{
  const a=goodSession();a.planVersion=1;assert.doesNotThrow(()=>parseSession(JSON.stringify(a)));
  assert.throws(()=>verifyResume({...a,complete:false}),/cannot be resumed/);
});
