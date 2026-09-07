import { createLink, normaliseRoomCode } from './net.js?v=2.2.0';
import { Sensor } from './sensor.js?v=2.2.0';
import { TARGETS } from './patches.js?v=2.2.0';
import { BUILD, PROTOCOL, PRESETS, STAGES, formatTime, isIPhoneSafari } from './config.js?v=2.2.0';
import { MODES, verifyResume, planFor } from './modes.js?v=2.2.0';
import { squareGuide, detectSquare, sampleRegions, alignmentAdvice, movementAmount, validQuad } from './alignment.js?v=2.2.0';
import { MotionGuard } from './motion.js?v=2.2.0';
import { TestRunner } from './runner.js?v=2.2.0';
import { SessionStore, preference } from './storage.js?v=2.2.0';
import { createSession, sessionBlob } from './session.js?v=2.2.0';
import { delay, throwIfAborted, withDeadline, abortError } from './async.js?v=2.2.0';
import { makeReport } from './report.js?v=2.2.0';
import { buildCorrectionLut } from './analysis.js?v=2.2.0';
import { download, buildIccProfile, buildArgyllCal, buildCsv } from './icc.js?v=2.2.0';

import { CaptureError, captureIssues, blockers, rememberWarnings, issue, referenceDrift } from './capture.js?v=2.2.0';
import { VisualMotionGuard } from './tracking.js?v=2.2.0';
import { comparisonBaseline, analyseVerification } from './verification.js?v=2.2.0';

const CAMERA_FIX = 'camera-fix-1';
const $ = selector => document.querySelector(selector);
const link = createLink(), store = new SessionStore('phone'), motion = new MotionGuard();
const visualMotion = new VisualMotionGuard(), baselineStore = new SessionStore('comparison-baseline');
const state = { sensor: null, startingCamera: false, setupController: null, paired: false,
  target: preference('target') || 'gamma22', run: preference('run') || 'standard',
  ready: false, locked: false, helpAction: 'align', lockedQuad: null, detected: null, detectedAt: 0,
  advice: null, lastDetectedAt: 0, movementHits: 0, diagnosticsActive: false,
  manualPoints: [], marking: false, manualQuad: null, pendingReview: null, pendingComparison: null, trackingDisabled: false, report: null, logs: [], lastLog: '', lastLive: 0, setupInfo: null };
if (!TARGETS[state.target]) state.target = 'gamma22';
if (!MODES[state.run]) state.run = 'standard';
const detector = document.createElement('canvas');
const detectorContext = detector.getContext('2d', { willReadFrequently: true });

function say(message, bad = false) {
  $('#status').textContent = message; $('#status').classList.toggle('bad', bad);
}
function log(kind, message) {
  const key = kind + ':' + message; if (state.lastLog === key) return;
  state.lastLog = key; state.logs.push({ at: new Date().toISOString(), kind, message: String(message).slice(0, 500) });
  if (state.logs.length > 300) state.logs.shift();
  $('#event-log').textContent = state.logs.slice(-10).map(e => `${e.at.slice(11, 19)} ${e.kind}: ${e.message}`).join('\n');
}
function setupStatus(label, phase = 'aligning') {
  say(label, phase === 'error'); $('#stage-message').textContent = label;
  if (runner.busy) runner.emit('preflight', label);
  else link.send({ t: 'setup', phase, label: label.slice(0, 500) });
  log(phase, label);
}
function controls() {
  const busy = runner.busy || Boolean(state.setupController) || state.startingCamera;
  const camera = Boolean(state.sensor?.running);
  for (const id of ['target', 'run-type']) $('#' + id).disabled = busy || Boolean(state.pendingComparison);
  for (const id of ['mark-corners', 'undo-corner', 'auto-corners', 'pause-movement', 'prepare-pattern', 'prepare-done', 'cancel-comparison']) $('#' + id).disabled = busy;
  for (const input of document.querySelectorAll('[name=monitor-control]')) input.disabled = busy;
  $('#verify-after').disabled = busy || !runner.session?.complete || runner.session?.synthetic || !analyseVerification(runner.session);
  $('#comparison-pending').classList.toggle('hidden', !state.pendingComparison);
  $('#start-camera').disabled = !state.paired || busy;
  $('#lock-sampling').disabled = !state.paired || !camera || busy;
  $('#show-alignment').disabled = !state.paired || !camera || busy;
  $('#run').disabled = !state.paired || !camera || !state.ready || busy;
  $('#resume').disabled = !state.paired || !camera || !state.ready || busy || !runner.session || runner.session.complete;
  $('#resume').classList.toggle('hidden', Boolean(runner.session?.complete));
  $('#pause').classList.toggle('hidden', !runner.busy);
  $('#cancel').classList.toggle('hidden', !runner.busy);
  $('#cancel').disabled = false;
  $('#help-retry').disabled = busy;
  $('#stop-camera').disabled = !camera && !state.startingCamera;
  $('#enable-motion').disabled = busy || motion.enabled;
  $('#disconnect').disabled = link.state !== 'open';
  $('#save-phone-session').disabled = !runner.session;
  $('#use-monitor-backup').disabled = !state.paired || busy;
  $('#clear-phone').disabled = busy;
  $('#new-test').disabled = busy;
  $('#join').disabled = link.state === 'connecting';
  $('#lock-sampling').textContent = state.locked ? 'Positions locked' : 'Lock sample positions';
  document.body.classList.toggle('capture-active', camera);
  document.body.classList.toggle('positions-locked', state.locked);
  document.body.classList.toggle('test-active', runner.busy);
  const recoverable = runner.session && !runner.session.complete && !runner.busy;
  $('#recovery').classList.toggle('hidden', !recoverable);
  if (recoverable) {
    $('#recovery-title').textContent = `${runner.session.readings.length}/${runner.session.expected} readings saved`;
    $('#recovery-note').textContent = runner.session.reason || 'Realign and lock sampling, then resume.';
  }
}
function choose() {
  const mode = MODES[state.run];
  $('#test-name').textContent = mode.name + (state.run === 'standard' ? ' / Recommended' : '');
  $('#test-duration').textContent = mode.estimate; $('#test-description').textContent = mode.detail;
  $('#run').textContent = state.pendingComparison ? 'Run fresh verification (~45-75 sec)' : `Run ${mode.name}`;
  if (!runner.busy) $('#eta').textContent = mode.estimate;
  preference('target', state.target); preference('run', state.run);
  link.send({ t: 'target', target: state.target });
}
function applyInterface() {
  const advanced = $('#advanced').checked; document.body.classList.toggle('advanced', advanced);
  preference('advanced', advanced ? '1' : '0');
  for (const node of document.querySelectorAll('details.technical')) node.open = advanced;
}
$('#advanced').checked = preference('advanced') === '1';
$('#advanced').addEventListener('change', applyInterface);
const presets = document.createElement('optgroup'); presets.label = 'Simple presets (SDR)';
for (const p of PRESETS) { const option = new Option(p.name, 'preset:' + p.id); presets.appendChild(option); }
const technical = document.createElement('optgroup'); technical.label = 'Technical tone-response targets';
for (const target of Object.values(TARGETS)) technical.appendChild(new Option(target.name, target.id));
$('#target').append(presets, technical); $('#target').value = state.target;
for (const mode of Object.values(MODES)) $('#run-type').appendChild(new Option(`${mode.name}${mode.id === 'standard' ? ' - Recommended' : ''} / ${mode.estimate}`, mode.id));
$('#run-type').value = state.run;
$('#target').addEventListener('change', event => {
  const value = event.target.value; state.target = value.startsWith('preset:') ? PRESETS.find(p => 'preset:' + p.id === value).target : value; choose();
});
$('#run-type').addEventListener('change', event => { state.run = event.target.value; choose(); });

async function render(message, signal) {
  throwIfAborted(signal);
  await link.request({ t: 'render', ...message, ...(runner.busy ? { sessionId: runner.session.sessionId } : {}) }, 5000, { signal });
  throwIfAborted(signal);
}
async function showAlignment() {
  if (!state.paired) return;
  state.ready = false; state.locked = false; state.marking = false; state.manualQuad = null; state.manualPoints = []; motion.disarm(); visualMotion.reset();
  $('#guide-layer').classList.remove('marking');
  await render({ layout: 'alignment', test: [0.65, 0.65, 0.65], anchor: 0.5, label: 'Position approximately or mark the four corners on your phone' });
  setupStatus('The guide is a suggestion, not a target score. Use the detected square, mark corners manually, or lock the approximate guide.');
  $('#lock-confirmation').textContent = 'Realign, then lock sampling. Do not move the phone after locking.';
  $('#preview-dock').scrollIntoView({ block: 'start', behavior: 'auto' }); controls();
}
$('#show-alignment').addEventListener('click', () => showAlignment().catch(error => help(error.message)));

function findCorners(rectangular = false) {
  const sensor = state.sensor;
  if (!sensor?.lastFrame || performance.now() - sensor.lastFrame.ts > 1500) return null;
  const w = 240, h = Math.round(w * sensor.canvas.height / sensor.canvas.width);
  if (detector.width !== w || detector.height !== h) { detector.width = w; detector.height = h; }
  detectorContext.drawImage(sensor.canvas, 0, 0, w, h);
  return detectSquare(detectorContext.getImageData(0, 0, w, h), { rectangular });
}
function previewGeometry() {
  const sensor = state.sensor; if (!sensor) return;
  const w = sensor.video.videoWidth || sensor.canvas.width || 480, h = sensor.video.videoHeight || sensor.canvas.height || 640;
  const ratio = w / h;
  $('#camera-viewport').style.aspectRatio = `${w} / ${h}`;
  $('#camera-viewport').style.width = `min(100%, ${Math.min(60, 38 * ratio)}svh)`;
  $('#guide-layer').setAttribute('viewBox', `0 0 ${w} ${h}`);
  const guide = squareGuide(w, h);
  const points = q => q.map(p => `${p.x * w},${p.y * h}`).join(' ');
  $('#square-guide').setAttribute('points', points(state.locked ? state.lockedQuad : state.manualQuad || guide));
  $('#square-guide').classList.toggle('is-locked', state.locked);
  $('#detected-guide').setAttribute('points', state.detected ? points(state.detected) : '');
  const layer = $('#locked-samples'); layer.replaceChildren();
  const regions = state.locked ? sensor.regions : sampleRegions(state.manualQuad || state.detected || guide, w, h);
  for (const [key, region] of Object.entries(regions)) {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const r = region.r * Math.min(w, h);
    rect.setAttribute('x', region.x * w - r); rect.setAttribute('y', region.y * h - r);
    rect.setAttribute('width', r * 2); rect.setAttribute('height', r * 2); rect.setAttribute('class', 'sample-square ' + key);
    layer.appendChild(rect);
  }
}
function liveFrame(event) {
  const frame = event.detail; if (!frame || performance.now() - state.lastLive < 200) return;
  state.lastLive = performance.now();
  $('#live-ratio').textContent = frame.ratio.map(v => v.toFixed(3)).join(' / ');
  $('#live-quality').textContent = frame.clipping > 0.02 ? `Clipping ${(frame.clipping * 100).toFixed(1)}%` : 'Fresh frames';
  $('#live-quality').className = frame.clipping > 0.02 ? 'warning' : 'good';
  if (state.diagnosticsActive) return;
  state.detected = findCorners();
  const w = state.sensor.canvas.width, h = state.sensor.canvas.height;
  if (state.detected) state.detectedAt = performance.now();
  state.advice = alignmentAdvice(state.manualQuad || state.detected, squareGuide(w, h), w, h);
  if (!state.locked) {
    $('#alignment-grade').textContent = state.manualQuad ? 'Manually positioned' : state.advice.grade;
    if (!state.marking) $('#align-hint').textContent = state.manualQuad ? 'Using your four corners. Lock the sample positions when they sit inside the patches.' : state.advice.message;
    state.sensor.regions = sampleRegions(state.manualQuad || state.detected || squareGuide(w, h), w, h);
  } else {
    $('#alignment-grade').textContent = 'Positions locked';
    $('#align-hint').textContent = 'Samples are fixed. Do not follow the changing patches. A perfect square match was not required.';
  }
  const watching = runner.busy && ['rendering', 'settling', 'sampling', 'checking', 'saving'].includes(runner.phase);
  if (watching && runner.session.telemetry.visualTracking && !state.trackingDisabled && state.lockedQuad) {
    const movement = visualMotion.check(state.lockedQuad, state.detected, w, h);
    if (movement === 'moved') runner.pause('Phone moved substantially. Position the samples again, lock and resume. Small guide differences are fine.', 'movements');
    if (movement === 'lost') runner.pause('Markers have been hidden for eight seconds. You can realign or continue without visual movement checks.', 'movements');
    $('#movement-status').textContent = { steady: 'Movement check: steady', minor: 'Small movement; test continues', searching: 'Looking for markers; test continues', moved: 'Movement pause', lost: 'Markers not visible' }[movement];
  }
  previewGeometry(); drawManualPoints();
}
function drawManualPoints() {
  const g = $('#manual-corners'); g.replaceChildren();
  const w = state.sensor?.video.videoWidth || 480, h = state.sensor?.video.videoHeight || 640;
  state.manualPoints.forEach((p, i) => {
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', p.x * w); text.setAttribute('y', p.y * h); text.setAttribute('class', 'manual-label'); text.textContent = String(i + 1); g.append(text);
  });
}
function markingHint() {
  $('#align-hint').textContent = ['Tap the TOP-LEFT (magenta) corner marker.', 'Tap the TOP-RIGHT corner marker.', 'Tap the BOTTOM-RIGHT corner marker.', 'Tap the BOTTOM-LEFT corner marker.'][state.manualPoints.length] || 'Four corners selected. Lock sample positions.';
}
$('#mark-corners').addEventListener('click', () => {
  if (!state.sensor?.running || runner.busy) return;
  state.locked = state.ready = false; state.manualPoints = []; state.manualQuad = null; state.marking = true;
  $('#guide-layer').classList.add('marking'); markingHint(); controls();
});
$('#guide-layer').addEventListener('pointerdown', event => {
  if (!state.marking || runner.busy) return;
  event.preventDefault(); const box = event.currentTarget.getBoundingClientRect();
  state.manualPoints.push({ x: Math.max(.002, Math.min(.998, (event.clientX - box.left) / box.width)), y: Math.max(.002, Math.min(.998, (event.clientY - box.top) / box.height)) });
  if (state.manualPoints.length === 4) {
    if (!validQuad(state.manualPoints)) { state.manualPoints.pop(); $('#align-hint').textContent = 'These corners cross or are too small to sample. Tap the bottom-left marker again, or use Undo.'; drawManualPoints(); return; }
    state.manualQuad = structuredClone(state.manualPoints); state.marking = false; $('#guide-layer').classList.remove('marking');
    $('#align-hint').textContent = 'Four corners selected. The small samples should sit inside the two patches. Lock when ready.';
  } else markingHint();
  drawManualPoints(); previewGeometry(); controls();
});
$('#undo-corner').addEventListener('click', () => {
  if (!state.manualPoints.length) return;
  state.manualPoints.pop(); state.manualQuad = null; state.marking = true; state.locked = state.ready = false;
  $('#guide-layer').classList.add('marking'); markingHint(); drawManualPoints(); controls();
});
$('#auto-corners').addEventListener('click', () => {
  state.marking = state.locked = state.ready = false; state.manualPoints = []; state.manualQuad = null;
  $('#guide-layer').classList.remove('marking'); previewGeometry(); controls();
});
$('#pause-movement').addEventListener('change', () => { state.trackingDisabled = !$('#pause-movement').checked; });
async function startCamera() {
  if (state.startingCamera || runner.busy || state.setupController) return;
  state.startingCamera = true; state.ready = state.locked = false; controls();
  // The video must be in a VISIBLE layout before play(), including on Safari.
  $('#preview-dock').classList.remove('hidden'); $('#camera-setup').classList.add('hidden');
  const sensor = new Sensor($('#cam'), $('#sampler')); state.sensor?.stop(); state.sensor = sensor;
  sensor.addEventListener('frame', liveFrame); sensor.addEventListener('resize', () => {
    if (state.locked) {
      state.ready = false; state.locked = false;
      runner.pause('Camera orientation or resolution changed. Realign and lock sampling before resuming.', 'movements');
      say('Camera image size changed. Realign and lock sampling again.', true);
    }
    previewGeometry(); controls();
  });
  sensor.addEventListener('stall', event => { if (runner.busy) runner.pause(event.detail.message); log('camera', event.detail.message); });
  sensor.addEventListener('error', event => { runner.pause(event.detail.message); state.ready = false; help(event.detail.message); controls(); });
  try {
    await showAlignment(); setupStatus('Allow the camera in Safari. Keep this preview visible.', 'camera');
    await sensor.start();
    if (!state.paired || document.hidden) throw new Error('Keep Safari visible and reconnect before starting the camera.');
    previewGeometry(); setupStatus('Camera fix 1 active. Position approximately, rest the phone and lock sampling.');
    holdWake();
  } catch (error) {
    sensor.stop(); state.sensor = null;
    $('#preview-dock').classList.add('hidden'); $('#camera-setup').classList.remove('hidden');
    const note = error.name === 'NotAllowedError' ? 'Camera access was denied. Allow Camera for this website in Safari, then retry.' : error.message;
    help(note);
  } finally { state.startingCamera = false; controls(); }
}
$('#start-camera').addEventListener('click', startCamera);
function stopCamera() {
  state.setupController?.abort(abortError('Camera stopped.'));
  runner.pause('Camera stopped. Start it again, realign and resume.');
  state.sensor?.stop(); state.ready = state.locked = false; motion.disarm();
  $('#camera-setup').classList.remove('hidden'); $('#preview-dock').classList.add('hidden'); controls();
}
$('#stop-camera').addEventListener('click', stopCamera);

// Keep the requested sample count. Slow capture gets a bounded longer window,
// not repeated copies of the same camera image or a silently reduced minimum.
function cameraMeasure(options) {
  const maxMs = state.sensor.measurementBudget(options.minSamples, options.maxMs);
  if (maxMs > options.maxMs) log('camera', `Slow capture: allowing ${(maxMs / 1000).toFixed(1)} seconds for ${options.minSamples} fresh frames.`);
  return state.sensor.measure({ ...options, maxMs });
}
async function retryCamera() {
  if (runner.busy || state.startingCamera || state.setupController) return;
  if (!state.sensor?.running || state.sensor.track?.readyState === 'ended') { await startCamera(); return; }
  const sensor = state.sensor, controller = new AbortController();
  state.setupController = controller; state.ready = false; controls();
  const oldSize = [sensor.video.videoWidth, sensor.video.videoHeight];
  try {
    $('#preview-dock').classList.remove('hidden');
    $('#preview-dock').scrollIntoView({ block: 'start', behavior: 'auto' });
    setupStatus('Retrying the camera sampler. Keep Safari visible and the phone still.', 'camera');
    const flow = await sensor.recover({ signal: controller.signal });
    throwIfAborted(controller.signal);
    if (!state.paired || document.hidden) throw new Error('Keep Safari visible and reconnect before retrying the camera.');
    if (oldSize[0] !== sensor.video.videoWidth || oldSize[1] !== sensor.video.videoHeight) state.locked = false;
    state.ready = state.locked; previewGeometry();
    log('camera', `Recovered using ${flow.lastSource}; ${flow.accepted} fresh samples accepted.`);
    setupStatus(state.ready ? 'Camera recovered. Locked positions and saved readings are retained. Resume or Run rechecks exposure and the reference.' : 'Camera recovered. Check the sample positions and lock them before continuing.', state.ready ? 'ready' : 'aligning');
  } catch (error) {
    if (!controller.signal.aborted) {
      help(error.message, Boolean(runner.session), error);
      state.helpAction = 'restart-camera'; $('#help-retry').textContent = 'Restart camera';
    }
  } finally {
    if (state.setupController === controller) state.setupController = null;
    controls();
  }
}

async function preflight(session, signal, resume = false) {
  const sensor = state.sensor;
  if (!state.locked || !sensor?.running) throw new Error('Start the camera and lock the sample positions. Perfect alignment is not required.');
  await withDeadline(() => sensor.video.play(), 3000, 'Camera playback is paused. Restart the camera.', signal);
  const warnings = [], white = { kind: 'grey', level: 1, test: [1, 1, 1], anchor: 1, label: 'Exposure check' };
  setupStatus('Checking the camera on a white patch. Keep the phone still.', 'exposure');
  await render(white, signal);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await cameraMeasure({ settleMs: 900, minSamples: 18, maxMs: 2800, tolerance: 0.025, signal });
    if (result.clipping <= 0.02) break;
    if (attempt === 2 || !await sensor.lowerExposure(signal)) break;
    setupStatus('Reducing camera exposure where supported...', 'exposure');
  }
  const whiteIssues = captureIssues({ patch: white, result });
  if (blockers(whiteIssues).length) throw new CaptureError(blockers(whiteIssues));
  warnings.push(...whiteIssues);
  const locked = await sensor.lockCamera({ signal }); throwIfAborted(signal);
  session.telemetry = { ...session.telemetry, exposureLocked: locked.exposure, whiteBalanceLocked: locked.whiteBalance,
    motionEnabled: motion.enabled, visualTracking: state.setupInfo?.automatic === true, trackingDisabled: state.trackingDisabled };
  session.alignment = state.setupInfo || { grade: 'Manual', automatic: false };
  session.displaySetup = { controls: [...document.querySelectorAll('[name=monitor-control]:checked')].map(n => n.value) };
  $('#cam-caps').textContent = `Camera fix 1 / Exposure: ${locked.exposure ? 'confirmed locked' : 'automatic / unconfirmed'}; white balance: ${locked.whiteBalance ? 'confirmed locked' : 'automatic / unconfirmed'}; focus: ${locked.focus ? 'confirmed locked' : 'automatic / unconfirmed'}.`;
  const informational = [];
  if (!locked.exposure || !locked.whiteBalance) informational.push(issue('camera-auto', 'Safari camera controls remain automatic', 'The test can run, but no absolute colour accuracy or correction-file eligibility is implied.'));
  if (!session.alignment.automatic) informational.push(issue('manual-position', 'Sampling positions were chosen manually', 'Automatic marker detection was not confirmed. Hold the phone still.'));
  if (state.trackingDisabled) informational.push(issue('tracking-off', 'Automatic visual movement pauses are off', 'The sample positions remain fixed. Rest the phone on a stand.'));
  rememberWarnings(session, informational, 'setup');
  setupStatus('Checking that the samples follow the actual monitor patches...', 'exposure');
  const reference = { kind: 'reference', test: [0.75, 0.75, 0.75], anchor: 0.5, label: 'Reference validation' };
  await render(reference, signal);
  result = await cameraMeasure({ settleMs: 900, minSamples: 24, maxMs: 3200, tolerance: 0.02, signal });
  const refIssues = captureIssues({ patch: reference, result });
  if (blockers(refIssues).length) throw new CaptureError(blockers(refIssues));
  warnings.push(...refIssues);
  const baseline = { ratio: result.ratio, anchorLinear: result.anchorLinear };
  const high = result.lumaRatio;
  await render({ test: [0.25, 0.25, 0.25], anchor: 0.5, label: 'Sample-position check' }, signal);
  const low = await cameraMeasure({ settleMs: 700, minSamples: 18, maxMs: 2600, tolerance: 0.025, signal });
  if (low.lumaRatio >= high * .85) warnings.push(issue('sample-location', 'The test sample did not follow the patch change', 'Check that the right sample sits inside the right patch. Use Mark four corners instead of trying to match the guide. Continuing produces a diagnostic report only.'));
  if (resume && session.baseline) {
    const drift = referenceDrift(baseline, session.baseline);
    session.telemetry.referenceDrift = Math.max(session.telemetry.referenceDrift || 0, drift);
    if (drift > .08) warnings.push(issue('resume-reference', 'The saved reference changed since the pause', 'Start a fresh test after changing monitor settings. You may continue for diagnostics, but the mixed readings will not be eligible for correction exports.'));
  }
  $('#capture-summary').textContent = warnings.length ? warnings.map(w => w.title).join('. ') : 'Frames received; sample response checked. Automatic camera controls, where unsupported, are noted in the report.';
  $('#capture-summary').classList.remove('hidden');
  visualMotion.reset(); state.ready = true;
  return { ...baseline, warnings: [...new Map(warnings.map(w => [w.code, w])).values()] };
}
async function lockSampling() {
  if (!state.sensor?.running || runner.busy || state.setupController) return;
  const sensor = state.sensor, w = sensor.canvas.width, h = sensor.canvas.height;
  const automatic = !state.manualQuad && Boolean(state.detected && performance.now() - state.detectedAt < 1200);
  state.lockedQuad = structuredClone(state.manualQuad || (automatic ? state.detected : squareGuide(w, h)));
  sensor.regions = sampleRegions(state.lockedQuad, w, h);
  state.setupInfo = { grade: automatic ? state.advice?.grade || 'Fair' : 'Manual', automatic };
  // Lock saves geometry only. Capture checks run at Start and can be reviewed.
  state.locked = state.ready = true; state.marking = false; $('#guide-layer').classList.remove('marking');
  visualMotion.reset(); previewGeometry();
  $('#lock-confirmation').textContent = automatic ? 'Positions locked. The detected square does not have to overlap the guide. Ready to run.' : 'Manual positions locked. Check the two small samples sit inside their patches. Ready to run.';
  $('#stage-title').textContent = 'Ready to run';
  setupStatus('Positions locked. Run the test; recoverable camera warnings can be continued as diagnostics.', 'ready'); controls();
}
$('#lock-sampling').addEventListener('click', lockSampling);
$('#enable-motion').addEventListener('click', async () => {
  try {
    const granted = await motion.enable();
    $('#motion-note').textContent = granted ? 'iPhone motion sensor enabled. Significant motion pauses the test; small or slow movement may still be missed.' : 'Movement permission was unavailable or denied. Visual marker checks remain available; use a stand.';
  } catch { $('#motion-note').textContent = 'Movement access was not granted. Visual checks remain available; use a stand.'; }
  controls();
});
motion.addEventListener('movement', () => runner.pause('Phone movement detected. Realign, lock sampling and resume.', 'movements'));

async function save(session) {
  const result = await store.save(session);
  $('#saved-info').textContent = result.saved ? `Saved on this device (${result.backend}). Readings are also checkpointed to the monitor.` : 'Browser storage unavailable. Keep this page open and save a JSON backup.';
  return result;
}
async function diagnostics(session, mode, signal) {
  state.diagnosticsActive = true;
  try {
    if (mode.uniformity && !session.uniformity && !session.omissions.uniformity) {
      try {
        runner.emit('diagnostics', 'Checking whether the camera can see all four field corners. Do not move the phone.');
        await render({ layout: 'field', test: [0.5, 0.5, 0.5], anchor: 0.5, label: 'Conditional field uniformity' }, signal);
        let q = null, confirmations = 0;
        for (let i = 0; i < 15; i++) {
          await delay(250, signal); const found = findCorners(true);
          if (found && q && movementAmount(q, found, state.sensor.canvas.width, state.sensor.canvas.height) < 0.04) confirmations++;
          else confirmations = 0;
          q = found;
          if (confirmations >= 2) break;
        }
        if (!q || confirmations < 2) throw new Error('Not measured: all four display-field corners were not visible and steady. The phone was not moved.');
        await cameraMeasure({ settleMs: 600, minSamples: 18, maxMs: 2500, tolerance: 0.02, signal });
        const captures = [];
        for (let i = 0; i < 3; i++) {
          await delay(180, signal); const current = findCorners(true);
          if (!current || movementAmount(q, current, state.sensor.canvas.width, state.sensor.canvas.height) > 0.04)
            throw new Error('Not measured: field corners moved during uniformity capture.');
          captures.push(state.sensor.projectedGrid(q, mode.uniformity));
        }
        const u = captures[0];
        u.cells.forEach((c, i) => { c.luma = captures.reduce((s, v) => s + v.cells[i].luma, 0) / captures.length; });
        const centre = u.cells[Math.floor(u.rows / 2) * u.cols + Math.floor(u.cols / 2)].luma;
        u.cells.forEach(c => { c.relative = c.luma / centre; c.deviation = (c.relative - 1) * 100; });
        const levels = u.cells.map(c => c.luma); u.worstDeviation = Math.max(...u.cells.map(c => Math.abs(c.deviation)));
        u.spread = (Math.max(...levels) - Math.min(...levels)) / Math.max(...levels) * 100;
        session.uniformity = u;
      } catch (error) { throwIfAborted(signal); session.omissions.uniformity = String(error.message).slice(0, 500); log('uniformity', error.message); }
    }
    if (mode.temporal && !session.flicker && !session.omissions.temporal) {
      try {
        runner.emit('diagnostics', 'Checking camera-frame temporal variation for five seconds...');
        await render({ test: [0.5, 0.5, 0.5], anchor: 0.5, label: 'Temporal variation' }, signal);
        session.flicker = await state.sensor.flickerScan(5000, { signal });
      } catch (error) { throwIfAborted(signal); session.omissions.temporal = String(error.message).slice(0, 500); log('temporal', error.message); }
    }
  } finally { state.diagnosticsActive = false; state.lastDetectedAt = performance.now(); }
}
const runner = new TestRunner({
  begin: async (session, signal) => {
    if (!state.paired) throw new Error('Reconnect to the monitor before starting.');
    await link.request({ t: 'run-start', sessionId: session.sessionId, expected: session.expected, target: session.target, run: session.run, purpose: session.purpose }, 5000, { signal });
  }, preflight, review: reviewCapture, render, measure: cameraMeasure, save,
  checkpoint: (session, signal) => link.request({ t: 'checkpoint', session: createSession(session) }, 5000, { signal }),
  notify: message => { link.send(message); log(message.phase, message.label); }, diagnostics,
  results: session => { link.send({ t: 'results', ...createSession(session) }); displayReport(session); },
  failure: (reason, session, error) => { state.ready = false; motion.disarm(); if (session) displayReport(session); help(reason, Boolean(session), error);
    if (session?.complete) { $('#stage-title').textContent = 'Test complete / sync needs attention'; $('#help-title').textContent = 'Report saved on this phone'; } },
}, { deadlines: { measureExtra: 13000, preflight: 90000, diagnostics: 45000 } });
runner.addEventListener('status', event => {
  const s = event.detail, pct = s.phase === 'complete' ? 100 : Math.min(99, 100 * s.done / s.total);
  $('#stage-title').textContent = STAGES[s.phase] || s.phase; $('#stage-message').textContent = s.label;
  $('#progress-label').textContent = `${s.done} / ${s.total} readings`; $('#eta').textContent = s.phase === 'review' ? 'Waiting for your choice' : ['paused', 'stopped'].includes(s.phase) ? 'Paused' : s.phase === 'complete' ? 'Finished' : `${formatTime(s.remaining)} left`;
  $('#prog').style.width = `${pct}%`; $('#progress').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('#elapsed').textContent = `Active time ${Math.floor(s.elapsedMs / 60000)}m ${Math.floor(s.elapsedMs / 1000) % 60}s`;
  if (!state.trackingDisabled && ['rendering', 'settling', 'sampling', 'checking', 'saving'].includes(s.phase) && !motion.armed) motion.arm();
  if (['paused', 'stopped', 'complete', 'review'].includes(s.phase)) motion.disarm();
  controls();
});
runner.addEventListener('finished', () => { motion.disarm(); controls(); });
$('#run').addEventListener('click', async () => {
  if (!state.ready || runner.busy) return;
  if (runner.session && !runner.session.complete && runner.session.readings.length && !confirm('Start a new test instead of resuming? Save the current JSON first if you need the partial readings.')) return;
  $('#phone-report').classList.add('hidden'); $('#preview-dock').scrollIntoView({ block: 'start' });
  const comparison = state.pendingComparison; state.pendingComparison = null;
  await runner.start({ run: state.run, target: state.target, comparison }); choose();
});
$('#resume').addEventListener('click', async () => {
  if (!state.ready || !runner.session) return;
  state.run = runner.session.run; state.target = runner.session.target;
  $('#run-type').value = state.run; $('#target').value = state.target; choose();
  $('#preview-dock').scrollIntoView({ block: 'start' }); await runner.start({ resume: true });
});
$('#pause').addEventListener('click', () => runner.pause('Paused by you. Realign and lock sampling before resuming.'));
$('#cancel').addEventListener('click', () => runner.stop());
$('#new-test').addEventListener('click', () => {
  if (runner.busy || !confirm('Start over? Download the current JSON first if you need a backup of its readings.')) return;
  runner.session = null; runner.phase = 'idle'; state.report = null; state.pendingComparison = null; state.ready = false;
  $('#phone-report').classList.add('hidden'); $('#stage-title').textContent = 'Start a new test';
  showAlignment().catch(e => say(e.message, true)); controls();
});

function reviewCapture({ issues, stage }, signal) {
  return new Promise((resolve, reject) => {
    const dialog = $('#warning-dialog');
    $('#warning-title').textContent = issues[0].title;
    $('#warning-items').replaceChildren(...issues.map(i => {
      const p = document.createElement('p'); p.textContent = i.title + ': ' + i.detail; return p;
    }));
    $('#warning-stage').textContent = stage === 'setup' ? 'Before the first measurement' : 'Measurement quality warning';
    const finish = (choice, error) => {
      signal.removeEventListener('abort', cancel); state.pendingReview = null;
      if (dialog.open) dialog.close(); error ? reject(error) : resolve(choice);
    };
    const cancel = () => finish(null, abortError(signal.reason));
    state.pendingReview = choice => finish(choice);
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    dialog.showModal(); $('#warning-continue').focus();
  });
}
$('#warning-continue').addEventListener('click', () => state.pendingReview?.('continue'));
$('#warning-retry').addEventListener('click', () => state.pendingReview?.('retry'));
$('#warning-stop').addEventListener('click', () => state.pendingReview?.('stop'));
$('#warning-dialog').addEventListener('cancel', event => { event.preventDefault(); state.pendingReview?.('stop'); });
function help(reason, hasSession = Boolean(runner.session), error) {
  state.ready = false; say(reason, true); log('attention', reason);
  const frameProblem = /^CAMERA_(?:NO|SLOW)_FRAMES$/.test(error?.code || '') || /camera stalled|camera sampling is slow|no fresh camera frames|not enough camera frames|camera stopped supplying|camera stopped during|camera stopped\.|camera playback|camera stream ended|camera playback could not/i.test(reason);
  const slow = error?.code === 'CAMERA_SLOW_FRAMES' || /camera sampling is slow/i.test(reason);
  state.helpAction = frameProblem ? 'camera' : 'align';
  $('#help-retry').textContent = frameProblem ? 'Retry camera' : 'Realign & retry setup';
  const title = error?.issues?.[0]?.title || (frameProblem ? (slow ? 'Camera sampling is slow' : 'No fresh camera frames') : /clipp|overexposed/i.test(reason) ? 'Camera sample is overexposed' : /marker/i.test(reason) ? 'Movement markers are hidden' : /mov|align/i.test(reason) ? 'Reposition the samples' : /connect|monitor|acknowledge/i.test(reason) ? 'Monitor connection needs a retry' : 'Test paused: action required');
  $('#stage-title').textContent = title; $('#stage-message').textContent = reason;
  $('#help-title').textContent = title; $('#help-message').textContent = reason;
  $('#help-detail').textContent = frameProblem
    ? 'This is camera capture, not alignment. Retry camera restarts the sampler and waits for a new frame. Locked positions and completed readings are kept if the camera image size is unchanged. If that fails, Restart camera opens a new stream; then check and lock the positions again.'
    : /clipp|overexposed/i.test(reason)
    ? 'Retry camera setup and avoid reflections inside the two small samples. Moving farther away is not a reliable exposure fix. If you change monitor brightness, start a NEW test. Severely clipped pixels cannot be used even for a relative reading.'
    : 'Perfect alignment is not required. Use Mark four corners if detection cannot locate the patches. Keep Safari visible. Readings already saved remain available. Changed monitor settings require a fresh test.';
  $('#ignore-tracking').classList.toggle('hidden', !/markers.*hidden|markers.*visible/i.test(reason));
  if (!runner.busy) link.send({ t: 'setup', phase: 'error', label: reason.slice(0, 500) });
  const dialog = $('#help-dialog'); if (!dialog.open) dialog.showModal(); controls();
}
$('#help-close').addEventListener('click', () => $('#help-dialog').close());
$('#help-retry').addEventListener('click', () => {
  if (runner.busy || state.startingCamera || state.setupController) return;
  const action = state.helpAction; $('#help-dialog').close();
  if (action === 'restart-camera') startCamera();
  else if (action === 'camera') retryCamera();
  else showAlignment().catch(e => say(e.message, true));
});
$('#ignore-tracking').addEventListener('click', () => {
  state.trackingDisabled = true; $('#pause-movement').checked = false;
  if (runner.session) {
    runner.session.telemetry.trackingDisabled = true;
    rememberWarnings(runner.session, [issue('tracking-off', 'Visual tracking disabled by you', 'Fixed sample positions are retained. Check them before resuming.')], 'movement', true);
  }
  $('#help-dialog').close(); state.ready = state.locked && Boolean(state.sensor?.running);
  setupStatus('Visual movement checks are off. Inspect the fixed samples, then resume. A diagnostic report will record this choice.', 'ready'); controls();
});
function displayReport(session) {
  const r = makeReport(session); state.report = r; $('#phone-report').classList.remove('hidden');
  $('#phone-result-title').textContent = `${r.mode?.name || 'Saved test'} / ${r.target.name}`;
  $('#phone-quality').textContent = r.grade; $('#phone-quality').className = r.grade === 'Poor' ? 'bad' : r.grade === 'Fair' ? 'warning' : 'good';
  $('#phone-warnings').replaceChildren(...r.quality.warnings.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  $('#phone-coverage').replaceChildren(...r.coverage.map(c => {
    const box = document.createElement('div'); box.className = 'coverage-item' + (c.measured ? '' : ' not-measured');
    const title = document.createElement('strong'), note = document.createElement('p');
    title.textContent = c.name + ' / ' + (c.status || (c.measured ? 'Estimated' : 'Not measured')); note.textContent = c.note; note.className = 'small dim'; box.append(title, note); return box;
  }));
  $('#phone-advice').replaceChildren(...r.recommendations.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  $('#phone-metrics').replaceChildren(...r.rows.map(row => { const tr = document.createElement('tr'); for (const text of [row.metric, row.value]) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); } return tr; }));
  $('#phone-accept').checked = false;
  $('#phone-comparison').textContent = r.comparison ? r.comparison.status + '. ' + r.comparison.message + (Number.isFinite(r.comparison.beforeError) ? ` Before: ${r.comparison.beforeError.toFixed(2)} pp; after: ${r.comparison.afterError.toFixed(2)} pp.` : '') : 'No before/after verification has been run. Make any changes yourself, then run a fresh comparison below.';
  exportControls(); controls();
}
function exportControls() {
  const allowed = state.report?.quality.canExport && $('#phone-accept').checked;
  $('#phone-icc').disabled = $('#phone-cal').disabled = !allowed;
}
$('#phone-accept').addEventListener('change', exportControls);
function correction(kind) {
  try {
    if (!state.report?.quality.canExport || !$('#phone-accept').checked) throw new Error('Correction export is blocked. Review the data quality and acknowledgement.');
    const lut = buildCorrectionLut(state.report.grey, state.report.target);
    download(kind === 'icc' ? buildIccProfile({ description: 'Lumen experimental ' + state.report.target.id, lut, target: state.report.target }) : buildArgyllCal(lut), `lumen-experimental.${kind}`);
  } catch (e) { say(e.message, true); }
}
$('#phone-icc').addEventListener('click', () => correction('icc')); $('#phone-cal').addEventListener('click', () => correction('cal'));
$('#phone-csv').addEventListener('click', () => { if (runner.session) download(buildCsv(runner.session.readings, state.report?.grey), 'lumen-measurements.csv'); });
$('#save-phone-session').addEventListener('click', () => { if (runner.session) download(sessionBlob(runner.session), 'lumen-session.json'); });
$('#save-log').addEventListener('click', () => download(new Blob([JSON.stringify({ build: BUILD, cameraFix: CAMERA_FIX, frameFlow: state.sensor?.frameDiagnostics(), browser: navigator.userAgent, phase: runner.phase, camera: Object.fromEntries(Object.entries(state.sensor?.track?.getSettings?.() || {}).filter(([key]) => !['deviceId', 'groupId'].includes(key))), events: state.logs }, null, 2)], { type: 'application/json' }), 'lumen-diagnostics.json'));
$('#clear-phone').addEventListener('click', async () => { if (!confirm('Clear saved data on THIS device? Downloaded files and the monitor copy will remain.')) return; const ok = await store.clear(); await baselineStore.clear(); say(ok ? 'Saved phone copy cleared. The current in-memory report is unchanged.' : 'Storage is unavailable. Clear this website in Safari settings.'); });

function displayGuidance() {
  const selected = [...document.querySelectorAll('[name=monitor-control]:checked')].map(n => n.value);
  preference('monitor-controls', JSON.stringify(selected));
  const notes = [];
  if (selected.includes('brightness')) notes.push('Set a comfortable brightness now. Lumen cannot measure a calibrated nits target.');
  if (selected.includes('contrast')) notes.push('Leave contrast near its normal default; use the light and dark step pattern to check for merged tones.');
  if (selected.includes('gamma')) notes.push('Choose the monitor gamma preset nearest your selected target, if available.');
  if (selected.includes('temperature') || selected.includes('rgb')) notes.push('Use a suitable factory colour-temperature preset. Lumen cannot prescribe D65 or absolute RGB-gain numbers from an uncalibrated iPhone camera.');
  if (!notes.length) notes.push('No monitor controls are required. Keep the current picture settings unchanged during each run.');
  $('#display-guidance').textContent = notes.join(' ');
}
try {
  const saved = JSON.parse(preference('monitor-controls') || '[]');
  for (const input of document.querySelectorAll('[name=monitor-control]')) { input.checked = Array.isArray(saved) && saved.includes(input.value); input.addEventListener('change', displayGuidance); }
} catch {}
displayGuidance();
$('#prepare-pattern').addEventListener('click', async () => {
  try { state.ready = state.locked = false; await render({ layout: 'adjustment', test: [.5,.5,.5], anchor: .5, label: 'Visual monitor setup' }); setupStatus('Adjust only the monitor controls you have. Close enough is fine. Return to alignment when ready.', 'preparing'); }
  catch (e) { help(e.message); } finally { controls(); }
});
$('#prepare-done').addEventListener('click', () => showAlignment().catch(e => help(e.message)));
$('#verify-after').addEventListener('click', async () => {
  try {
    if (runner.busy) return;
    const baseline = comparisonBaseline(runner.session, $('#verify-action').value, $('#verify-note').value);
    const saved = await baselineStore.save(runner.session);
    if (!saved.saved && !confirm('Browser storage is unavailable. Save your original JSON first. Continue using an in-memory comparison baseline?')) return;
    state.pendingComparison = baseline; state.target = baseline.target;
    $('#target').value = state.target; $('#phone-report').classList.add('hidden');
    await showAlignment(); choose(); controls();
    $('#stage-title').textContent = 'Fresh before/after verification';
    setupStatus('The original report is preserved separately. Lock the current positions, then run a fresh verification. Lumen has not installed or applied a profile.', 'ready');
  } catch (e) { help(e.message); }
});
$('#save-baseline').addEventListener('click', async () => { const saved = await baselineStore.load(); if (saved) download(sessionBlob(saved), 'lumen-before-verification.json'); else say('No saved verification baseline on this device.'); });
$('#cancel-comparison').addEventListener('click', () => { state.pendingComparison = null; choose(); controls(); });
const params = new URLSearchParams(location.search); $('#room-input').value = (params.get('room') || '').toUpperCase().slice(0, 5);
$('#pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  try { const code = normaliseRoomCode($('#room-input').value); $('#room-input').value = code; say('Connecting to the monitor...'); await link.join(code); }
  catch (e) { say(e.message, true); log('connection', e.message); }
  finally { controls(); }
});
async function handshake() {
  state.paired = false;
  try {
    const reply = await link.request({ t: 'hello', version: BUILD, protocol: PROTOCOL }, 5000);
    if (reply.version !== BUILD || reply.protocol !== PROTOCOL) throw new Error('The phone and monitor loaded different Lumen versions. Refresh BOTH pages after updating the website.');
    state.paired = true; $('#pair').classList.add('hidden'); $('#console').classList.remove('hidden');
    say(`Connected / v${BUILD}. ${runner.session && !runner.session.complete ? 'Saved progress is available. Start the camera, realign and resume.' : 'Choose a test and start the camera.'}`);
    choose(); log('connection', 'Version-checked link ready');
  } catch (e) { say(e.message, true); $('#pair').classList.remove('hidden'); }
  finally { controls(); }
}
link.addEventListener('state', event => {
  const s = event.detail.state;
  if (s === 'open') handshake();
  if (['closed', 'error'].includes(s)) {
    state.paired = false; state.ready = false;
    state.setupController?.abort(abortError('Monitor disconnected. Reconnect and retry setup.'));
    runner.pause('Monitor disconnected. Readings are saved. Reconnect, realign and resume.', 'disconnects');
    $('#pair').classList.remove('hidden'); say(event.detail.error || 'Monitor disconnected. Reconnect with its code.', true);
  }
  controls();
});
link.addEventListener('message', event => {
  const msg = event.detail;
  if (msg.t === 'hello' && msg.__id) link.reply(msg, { t: 'hello', version: BUILD, protocol: PROTOCOL });
  if (msg.t === 'interrupt') {
    runner.pause(msg.reason); state.setupController?.abort(abortError(msg.reason)); state.ready = false; say(msg.reason, true);
  }
  if (msg.t === 'reset' && !runner.busy) { state.ready = false; say('Monitor is ready for another test. Your phone backup is retained.'); }
  controls();
});
$('#disconnect').addEventListener('click', () => { runner.pause('Disconnected by you. Reconnect and realign to resume.', 'disconnects'); state.paired = false; state.ready = false; link.destroy(); $('#pair').classList.remove('hidden'); controls(); });
$('#use-monitor-backup').addEventListener('click', async () => {
  try {
    if (runner.session?.readings.length && !confirm('Replace the phone recovery state with the monitor backup? Save the phone JSON first.')) return;
    const reply = await link.request({ t: 'recover' }, 5000);
    if (!reply.session) throw new Error('No resumable monitor backup is available.');
    verifyResume(reply.session); runner.restore(reply.session); state.ready = false;
    state.run = runner.session.run; state.target = runner.session.target; $('#run-type').value = state.run; $('#target').value = state.target;
    await store.save(runner.session); choose(); controls();
  } catch (e) { say(e.message, true); }
});
let wakeLock = null;
async function holdWake() {
  if (wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    runner.pause('Safari was hidden or the phone locked. Bring it back, realign and resume.');
    state.setupController?.abort(abortError('Safari was hidden during camera setup.'));
    state.ready = false; if (runner.session) store.saveSync(runner.session); wakeLock?.release();
  } else { holdWake(); state.sensor?.video.play().catch(() => {}); }
});
window.addEventListener('pagehide', () => { if (runner.session) store.saveSync({ ...runner.session, phase: runner.session.complete ? 'complete' : 'paused', reason: 'Page closed. Reconnect and revalidate before resuming.' }); state.sensor?.stop(); motion.destroy(); link.destroy(); wakeLock?.release(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') runner.stop(); });
window.addEventListener('unhandledrejection', e => { const reason = e.reason?.message || 'Unexpected browser error. Save diagnostics and retry.'; runner.pause(reason); say(reason, true); log('error', reason); });
window.addEventListener('error', e => { if (e.message) { runner.pause(e.message); say(e.message, true); log('error', e.message); } });
if (!isIPhoneSafari()) { $('#browser-note').classList.remove('hidden'); $('#browser-note').textContent = 'Capture is designed for iPhone Safari. This browser is not a supported capture device; demo and saved reports can still be viewed on the monitor page.'; }
window.lumen = { state, link, runner, store, preflight, showAlignment, lockSampling, reviewCapture, retryCamera, cameraFix: CAMERA_FIX };
$('#cam-caps').textContent = 'Camera fix 1 installed. Start the camera to read its capabilities.';
choose(); applyInterface(); controls();
store.load().then(saved => {
  // Do not race a user who has already started a new session.
  if (!saved || runner.session || runner.busy) return;
  if (saved.complete) { runner.session = saved; displayReport(saved); }
  else if (saved.run) {
    try { runner.restore(saved); state.run = saved.run; state.target = saved.target; $('#run-type').value = state.run; $('#target').value = state.target; choose(); }
    catch (e) { say(e.message, true); }
  }
  controls();
});
