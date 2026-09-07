import { createLink, normaliseRoomCode } from './net.js?v=2.1.0';
import { Sensor } from './sensor.js?v=2.1.0';
import { TARGETS } from './patches.js?v=2.1.0';
import { BUILD, PROTOCOL, PRESETS, STAGES, formatTime, isIPhoneSafari } from './config.js?v=2.1.0';
import { MODES, verifyResume } from './modes.js?v=2.1.0';
import { squareGuide, detectSquare, sampleRegions, alignmentAdvice, movementAmount } from './alignment.js?v=2.1.0';
import { MotionGuard } from './motion.js?v=2.1.0';
import { TestRunner } from './runner.js?v=2.1.0';
import { SessionStore, preference } from './storage.js?v=2.1.0';
import { createSession, sessionBlob } from './session.js?v=2.1.0';
import { delay, throwIfAborted, withDeadline, abortError } from './async.js?v=2.1.0';
import { makeReport } from './report.js?v=2.1.0';
import { buildCorrectionLut } from './analysis.js?v=2.1.0';
import { download, buildIccProfile, buildArgyllCal, buildCsv } from './icc.js?v=2.1.0';

const $ = selector => document.querySelector(selector);
const link = createLink(), store = new SessionStore('phone'), motion = new MotionGuard();
const state = { sensor: null, startingCamera: false, setupController: null, paired: false,
  target: preference('target') || 'gamma22', run: preference('run') || 'standard',
  ready: false, locked: false, lockedQuad: null, detected: null, detectedAt: 0,
  advice: null, lastDetectedAt: 0, movementHits: 0, diagnosticsActive: false,
  report: null, logs: [], lastLog: '', lastLive: 0, setupInfo: null };
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
  for (const id of ['target', 'run-type']) $('#' + id).disabled = busy;
  $('#start-camera').disabled = !state.paired || busy;
  $('#lock-sampling').disabled = !state.paired || !camera || busy;
  $('#show-alignment').disabled = !state.paired || !camera || busy;
  $('#run').disabled = !state.paired || !camera || !state.ready || busy;
  $('#resume').disabled = !state.paired || !camera || !state.ready || busy || !runner.session || runner.session.complete;
  $('#resume').classList.toggle('hidden', Boolean(runner.session?.complete));
  $('#pause').classList.toggle('hidden', !runner.busy);
  $('#cancel').classList.toggle('hidden', !runner.busy);
  $('#cancel').disabled = false;
  $('#stop-camera').disabled = !camera && !state.startingCamera;
  $('#enable-motion').disabled = busy || motion.enabled;
  $('#disconnect').disabled = link.state !== 'open';
  $('#save-phone-session').disabled = !runner.session;
  $('#use-monitor-backup').disabled = !state.paired || busy;
  $('#clear-phone').disabled = busy;
  $('#new-test').disabled = busy;
  $('#join').disabled = link.state === 'connecting';
  $('#lock-sampling').textContent = state.locked && state.ready ? 'Sampling locked' : 'Lock sampling';
  document.body.classList.toggle('capture-active', camera);
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
  $('#run').textContent = `Run ${mode.name}`;
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
  state.ready = false; state.locked = false; motion.disarm();
  await render({ layout: 'alignment', test: [0.65, 0.65, 0.65], anchor: 0.5, label: 'Match the square on your phone' });
  setupStatus('Match the monitor square to the phone guide, then lock sampling. Perfect alignment is not required.');
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
  $('#square-guide').setAttribute('points', points(state.locked ? state.lockedQuad : guide));
  $('#square-guide').classList.toggle('is-locked', state.locked);
  $('#detected-guide').setAttribute('points', state.detected ? points(state.detected) : '');
  const layer = $('#locked-samples'); layer.replaceChildren();
  const regions = state.locked ? sensor.regions : sampleRegions(state.detected || guide, w, h);
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
  $('#live-quality').textContent = frame.clipping > 0.02 ? 'Clipping' : 'Fresh frames';
  $('#live-quality').className = frame.clipping > 0.02 ? 'bad' : 'good';
  if (state.diagnosticsActive) return;
  state.detected = findCorners();
  const w = state.sensor.canvas.width, h = state.sensor.canvas.height;
  if (state.detected) { state.detectedAt = performance.now(); state.lastDetectedAt = performance.now(); }
  state.advice = alignmentAdvice(state.detected, squareGuide(w, h), w, h);
  if (!state.locked) {
    $('#alignment-grade').textContent = state.advice.grade;
    $('#align-hint').textContent = state.advice.message;
    // Let the live quality readout sample the provisional square, not arbitrary
    // old circle positions, before the user presses Lock.
    state.sensor.regions = sampleRegions(state.detected || squareGuide(w, h), w, h);
  } else {
    $('#alignment-grade').textContent = state.ready ? 'Locked' : 'Check camera';
    $('#align-hint').textContent = 'Sampling is fixed inside this square. Keep the phone still; do not follow changing patches.';
  }
  const watching = runner.busy && !['preflight', 'starting', 'paused', 'stopped', 'complete', 'diagnostics'].includes(runner.phase);
  if (watching && runner.session.telemetry.visualTracking && state.lockedQuad) {
    const moved = state.detected && movementAmount(state.lockedQuad, state.detected, w, h) > 0.045;
    state.movementHits = moved ? state.movementHits + 1 : 0;
    if (state.movementHits >= 3) runner.pause('Phone moved. Completed readings are saved. Realign the square, lock sampling and resume.', 'movements');
    if (!state.detected && performance.now() - state.lastDetectedAt > 2500)
      runner.pause('The alignment markers are no longer visible. Realign the square and resume. Completed readings are saved.', 'movements');
  }
  previewGeometry();
}
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
    previewGeometry(); setupStatus('Camera ready. Match the square, rest the phone and lock sampling.');
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

async function preflight(session, signal, resume = false) {
  const sensor = state.sensor;
  if (!state.locked || !sensor?.running) throw new Error('Align the square and lock sampling before testing.');
  await withDeadline(() => sensor.video.play(), 3000, 'Camera playback is paused. Restart the camera.', signal);
  const white = { test: [1, 1, 1], anchor: 1, label: 'Exposure and clipping check' };
  setupStatus('Checking full-white exposure. Keep the phone still.', 'exposure');
  await render(white, signal);
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = await sensor.measure({ settleMs: 900, minSamples: 18, maxMs: 2600, tolerance: 0.02, signal });
    if (result.clipping <= 0.02) break;
    if (attempt === 2 || !await sensor.lowerExposure(signal))
      throw new Error('Camera clipping detected. Safari could not reduce exposure enough. Do not start the measurement yet.');
    setupStatus('Reducing camera exposure and checking again...', 'exposure');
  }
  if (!result.converged || result.noise > 0.18 || (result.exposureDrift || 0) > 0.04)
    throw new Error('Camera exposure or alignment is not stable. Keep both samples inside the square and rest the phone.');
  setupStatus('Checking which camera settings Safari can lock...', 'exposure');
  const locked = await sensor.lockCamera({ signal });
  throwIfAborted(signal);
  session.telemetry = { ...session.telemetry, exposureLocked: locked.exposure,
    whiteBalanceLocked: locked.whiteBalance, motionEnabled: motion.enabled, visualTracking: state.setupInfo?.automatic === true };
  session.alignment = state.setupInfo || { grade: 'Manual', automatic: false };
  $('#cam-caps').textContent = `Exposure: ${locked.exposure ? 'confirmed locked' : 'automatic / unconfirmed'}; white balance: ${locked.whiteBalance ? 'confirmed locked' : 'automatic / unconfirmed'}; focus: ${locked.focus ? 'confirmed locked' : 'automatic / unconfirmed'}.`;
  setupStatus('Checking a reference pair for repeatable readings...', 'exposure');
  await render({ test: [0.75, 0.75, 0.75], anchor: 0.5, label: 'Reference validation' }, signal);
  result = await sensor.measure({ settleMs: 900, minSamples: 24, maxMs: 3200, tolerance: 0.015, signal });
  if (result.clipping > 0.02 || !result.converged || result.noise > 0.15 || Math.min(...result.anchorLinear) < 0.0001)
    throw new Error('The reference is clipped, too dark or unstable. Realign and retry camera setup.');
  const baseline = { ratio: result.ratio, anchorLinear: result.anchorLinear };
  if (resume && session.baseline) {
    const previous = session.baseline;
    const drift = Math.max(...baseline.ratio.map((v, i) => Math.abs(v / Math.max(previous.ratio[i], 0.005) - 1)));
    const currentLight = baseline.anchorLinear.reduce((a, b) => a + b, 0), oldLight = previous.anchorLinear.reduce((a, b) => a + b, 0);
    session.telemetry.referenceDrift = Math.max(session.telemetry.referenceDrift || 0, drift);
    if (drift > 0.08 || Math.abs(currentLight / Math.max(oldLight, 0.0003) - 1) > 0.25)
      throw new Error('The saved reference has changed too much to safely combine readings. Keep the saved JSON and start a new test, especially if monitor settings or camera exposure changed.');
  }
  state.ready = true; state.lastDetectedAt = performance.now(); state.movementHits = 0;
  return baseline;
}
async function lockSampling() {
  if (!state.sensor?.running || runner.busy || state.setupController) return;
  const sensor = state.sensor, w = sensor.canvas.width, h = sensor.canvas.height;
  const automatic = Boolean(state.detected && performance.now() - state.detectedAt < 1200);
  // Fair geometry never disables Lock. Undetected geometry uses the visible
  // square guide and is explicitly reported as a manual, lower-confidence lock.
  state.lockedQuad = structuredClone(automatic ? state.detected : squareGuide(w, h));
  sensor.regions = sampleRegions(state.lockedQuad, w, h);
  state.setupInfo = { grade: automatic ? state.advice?.grade || 'Fair' : 'Manual', automatic };
  state.locked = true; state.ready = false; previewGeometry();
  const controller = new AbortController(); state.setupController = controller; controls();
  try {
    await withDeadline(s => preflight({ telemetry: {}, baseline: null }, s), 30000, 'Camera setup timed out. Retry setup.', controller.signal);
    $('#lock-confirmation').textContent = automatic ? 'Sampling locked. Keep the phone still. Ready to run.' : 'Manual square locked. Keep the phone still. Alignment will be marked as unconfirmed in results.';
    $('#stage-title').textContent = 'Ready to test';
    setupStatus('Sampling locked. Camera checks passed. Run the selected test or resume saved progress.', 'ready');
  } catch (error) { state.ready = false; help(error.message); }
  finally { if (state.setupController === controller) state.setupController = null; controls(); }
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
        await state.sensor.measure({ settleMs: 600, minSamples: 18, maxMs: 2500, tolerance: 0.02, signal });
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
    await link.request({ t: 'run-start', sessionId: session.sessionId, expected: session.expected, target: session.target, run: session.run }, 5000, { signal });
  }, preflight, render, measure: options => state.sensor.measure(options), save,
  checkpoint: (session, signal) => link.request({ t: 'checkpoint', session: createSession(session) }, 5000, { signal }),
  notify: message => { link.send(message); log(message.phase, message.label); }, diagnostics,
  results: session => { link.send({ t: 'results', ...createSession(session) }); displayReport(session); },
  failure: (reason, session) => { state.ready = false; motion.disarm(); if (session) displayReport(session); help(reason, Boolean(session));
    if (session?.complete) { $('#stage-title').textContent = 'Test complete / sync needs attention'; $('#help-title').textContent = 'Report saved on this phone'; } },
});
runner.addEventListener('status', event => {
  const s = event.detail, pct = s.phase === 'complete' ? 100 : Math.min(99, 100 * s.done / s.total);
  $('#stage-title').textContent = STAGES[s.phase] || s.phase; $('#stage-message').textContent = s.label;
  $('#progress-label').textContent = `${s.done} / ${s.total} readings`; $('#eta').textContent = ['paused', 'stopped'].includes(s.phase) ? 'Paused' : s.phase === 'complete' ? 'Finished' : `${formatTime(s.remaining)} left`;
  $('#prog').style.width = `${pct}%`; $('#progress').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('#elapsed').textContent = `Active time ${Math.floor(s.elapsedMs / 60000)}m ${Math.floor(s.elapsedMs / 1000) % 60}s`;
  if (['rendering', 'settling', 'sampling', 'checking', 'saving'].includes(s.phase) && !motion.armed) motion.arm();
  if (['paused', 'stopped', 'complete'].includes(s.phase)) motion.disarm();
  controls();
});
runner.addEventListener('finished', () => { motion.disarm(); controls(); });
$('#run').addEventListener('click', async () => {
  if (!state.ready || runner.busy) return;
  if (runner.session && !runner.session.complete && runner.session.readings.length && !confirm('Start a new test instead of resuming? Save the current JSON first if you need the partial readings.')) return;
  $('#phone-report').classList.add('hidden'); $('#preview-dock').scrollIntoView({ block: 'start' });
  await runner.start({ run: state.run, target: state.target });
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
  runner.session = null; runner.phase = 'idle'; state.report = null; state.ready = false;
  $('#phone-report').classList.add('hidden'); $('#stage-title').textContent = 'Start a new test';
  showAlignment().catch(e => say(e.message, true)); controls();
});

function help(reason, hasSession = Boolean(runner.session)) {
  state.ready = false; say(reason, true); log('attention', reason);
  $('#stage-title').textContent = hasSession ? 'Test paused' : 'Camera setup needs attention';
  $('#stage-message').textContent = reason;
  $('#help-title').textContent = /clipp/i.test(reason) ? 'Camera is overexposed' : /mov|marker|align/i.test(reason) ? 'Realign the square' : 'Capture needs attention';
  $('#help-message').textContent = reason;
  $('#help-detail').textContent = /clipp/i.test(reason)
    ? 'First check that both samples sit inside their patches and remove reflections. Retry camera setup. Safari may not expose manual exposure controls. Moving farther away is not a reliable clipping fix. If you lower MONITOR brightness, start a NEW test rather than mixing old and new readings.'
    : 'Keep Safari in the foreground and the camera preview visible. Check the monitor connection. Realign and lock sampling before resuming. If you changed monitor settings, start a new test. Completed readings have not been discarded.';
  if (!runner.busy) link.send({ t: 'setup', phase: 'error', label: reason.slice(0, 500) });
  const dialog = $('#help-dialog'); if (!dialog.open) { if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', ''); }
  controls();
}
$('#help-close').addEventListener('click', () => $('#help-dialog').close());
$('#help-retry').addEventListener('click', () => { $('#help-dialog').close(); showAlignment().catch(e => say(e.message, true)); });

function displayReport(session) {
  const r = makeReport(session); state.report = r; $('#phone-report').classList.remove('hidden');
  $('#phone-result-title').textContent = `${r.mode?.name || 'Saved test'} / ${r.target.name}`;
  $('#phone-quality').textContent = r.grade; $('#phone-quality').className = r.grade === 'Poor' ? 'bad' : r.grade === 'Fair' ? 'warning' : 'good';
  $('#phone-warnings').replaceChildren(...r.quality.warnings.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  $('#phone-coverage').replaceChildren(...r.coverage.map(c => {
    const box = document.createElement('div'); box.className = 'coverage-item' + (c.measured ? '' : ' not-measured');
    const title = document.createElement('strong'), note = document.createElement('p');
    title.textContent = c.name + (c.measured ? ' / Measured' : ' / Not measured'); note.textContent = c.note; note.className = 'small dim'; box.append(title, note); return box;
  }));
  $('#phone-advice').replaceChildren(...r.recommendations.map(text => { const p = document.createElement('p'); p.textContent = text; return p; }));
  $('#phone-metrics').replaceChildren(...r.rows.map(row => { const tr = document.createElement('tr'); for (const text of [row.metric, row.value]) { const td = document.createElement('td'); td.textContent = text; tr.appendChild(td); } return tr; }));
  $('#phone-accept').checked = false; exportControls();
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
$('#save-log').addEventListener('click', () => download(new Blob([JSON.stringify({ build: BUILD, browser: navigator.userAgent, phase: runner.phase, camera: Object.fromEntries(Object.entries(state.sensor?.track?.getSettings?.() || {}).filter(([key]) => !['deviceId', 'groupId'].includes(key))), events: state.logs }, null, 2)], { type: 'application/json' }), 'lumen-diagnostics.json'));
$('#clear-phone').addEventListener('click', async () => { if (!confirm('Clear saved data on THIS device? Downloaded files and the monitor copy will remain.')) return; const ok = await store.clear(); say(ok ? 'Saved phone copy cleared. The current in-memory report is unchanged.' : 'Storage is unavailable. Clear this website in Safari settings.'); });

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
window.lumen = { state, link, runner, store, preflight, showAlignment };
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
