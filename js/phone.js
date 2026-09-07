// Phone-side controller: one operation at a time, cancellable at every wait.
import { createLink, normaliseRoomCode } from './net.js';
import { Sensor } from './sensor.js';
import { RUNS, TARGETS, uniformityFrame } from './patches.js';
import { clamp } from './colour.js';
import { delay, throwIfAborted, abortError } from './async.js';
import { readingIssues } from './quality.js';
import { sessionBlob, saveLastSession, newSessionId } from './session.js';
import { download } from './icc.js';

const $ = s => document.querySelector(s);
const link = createLink();
const state = {
  sensor: null, readings: [], uniformity: null, flicker: null,
  target: 'gamma22', resultTarget: 'gamma22', run: 'quick', mode: null,
  controller: null, startingCamera: false, complete: false, expected: 0, sessionId: '',
  bounds: { x: 0.08, y: 0.08, w: 0.84, h: 0.84 },
};

function say(text, bad = false) {
  $('#status').textContent = text;
  $('#status').classList.toggle('bad', bad);
}
function snapshot() {
  return { target: state.resultTarget, readings: state.readings, uniformity: state.uniformity,
    flicker: state.flicker, complete: state.complete, expected: state.expected, sessionId: state.sessionId };
}
function updateControls() {
  const busy = Boolean(state.mode), connected = link.state === 'open';
  const ready = connected && state.sensor?.running && !state.startingCamera;
  for (const id of ['run', 'tune', 'uniformity', 'flicker', 'show-alignment', 'lock-camera'])
    $('#' + id).disabled = !ready || busy;
  for (const id of ['target', 'run-type', 'reticle-size']) $('#' + id).disabled = busy;
  $('#start-camera').disabled = !connected || busy || state.startingCamera;
  $('#stop-camera').disabled = !state.sensor?.running;
  $('#cancel').classList.toggle('hidden', !busy || state.mode === 'camera-lock');
  $('#reticles').classList.toggle('locked', busy);
  $('#save-phone-session').disabled = !state.readings.length && !state.uniformity && !state.flicker;
  $('#disconnect').disabled = !connected;
}
function progress(done, total, label) {
  const percent = total ? done / total * 100 : 0;
  $('#prog').style.width = `${percent}%`;
  $('#progress').setAttribute('aria-valuenow', String(Math.round(percent)));
  $('#progress-label').textContent = `${done} / ${total} readings`;
  if (link.state === 'open' && total) link.send({ t: 'progress', done, total, label });
}
function cancel(reason = 'Stopped. Partial measurements have been kept.') {
  state.controller?.abort(abortError(reason));
}
$('#cancel').addEventListener('click', () => cancel());

const params = new URLSearchParams(location.search);
$('#room-input').value = (params.get('room') || '').toUpperCase().slice(0, 5);
$('#pair-form').addEventListener('submit', async event => {
  event.preventDefault();
  let code;
  try { code = normaliseRoomCode($('#room-input').value); } catch (error) { say(error.message, true); return; }
  $('#room-input').value = code;
  $('#join').disabled = true;
  say('Connecting to display...');
  try { await link.join(code); }
  catch (error) { say(error.message, true); }
  finally { $('#join').disabled = false; updateControls(); }
});
link.addEventListener('state', event => {
  const status = event.detail.state;
  if (status === 'open') {
    $('#pair').classList.add('hidden');
    $('#console').classList.remove('hidden');
    say('Connected. Start the camera and align the two sample circles.');
    link.send({ t: 'target', target: state.target });
  }
  if (['closed', 'error'].includes(status)) {
    cancel('Display disconnected. Partial measurements have been kept.');
    stopCamera();
    $('#pair').classList.remove('hidden');
    $('#join').disabled = false;
    say(event.detail.error || 'Display disconnected. Reconnect using its room code.', true);
  }
  updateControls();
});
link.addEventListener('message', event => {
  const msg = event.detail;
  if (msg.t === 'interrupt') cancel(msg.reason);
  if (msg.t === 'reset') {
    cancel('Session reset from display.');
    state.readings = []; state.uniformity = state.flicker = null;
    state.complete = false; state.expected = 0;
    progress(0, 0, 'Idle'); updateControls();
    say('Ready for a new measurement.');
  }
});
$('#disconnect').addEventListener('click', () => {
  cancel('Disconnected.'); stopCamera(); link.destroy();
  $('#pair').classList.remove('hidden');
  say('Disconnected. Enter a room code to connect again.'); updateControls();
});

async function render(message, signal) {
  throwIfAborted(signal);
  await link.request({ t: 'render', ...message }, 8000, { signal });
  throwIfAborted(signal);
}
async function showAlignment() {
  await render({ test: [0.75, 0.75, 0.75], anchor: 0.5, label: 'Alignment' });
  say('Drag the dashed circle into the left patch and the solid circle into the right patch.');
}
$('#show-alignment').addEventListener('click', () => showAlignment().catch(error => say(error.message, true)));
$('#start-camera').addEventListener('click', async () => {
  if (state.startingCamera || state.mode) return;
  state.startingCamera = true; updateControls();
  const sensor = new Sensor($('#cam'), $('#sampler'));
  for (const region of Object.values(sensor.regions)) region.r = Number($('#reticle-size').value) / 1000;
  state.sensor = sensor;
  try {
    await showAlignment();
    say('Allow camera access when your browser asks.');
    await sensor.start();
    if (link.state !== 'open' || document.hidden) throw new Error('Keep both pages visible and connected, then start the camera again.');
    $('#camera-setup').classList.add('hidden');
    $('#align').classList.remove('hidden');
    $('#cam-caps').textContent = 'Automatic camera controls; locks have not been requested.';
    $('#cam-note').textContent = 'Stable readings are not proof of accuracy. Clipping and local tone mapping do not cancel in the ratio.';
    sensor.addEventListener('frame', onLiveFrame);
    sensor.addEventListener('resize', syncPreview);
    sensor.addEventListener('error', event => { cancel(event.detail.message); stopCamera(); say(event.detail.message, true); });
    bindReticles(); syncPreview();
    say('Camera ready. Keep the phone steady and place both circles fully inside their patches.');
  } catch (error) {
    sensor.stop(); state.sensor = null;
    const hints = { NotAllowedError: 'Camera access was denied. Allow it in the browser site settings, then retry.',
      NotFoundError: 'No camera was found.', NotReadableError: 'Camera is unavailable or used by another app. Close that app and retry.' };
    say(hints[error.name] || error.message, true);
  } finally { state.startingCamera = false; updateControls(); }
});
function stopCamera() {
  cancel('Camera stopped. Partial measurements have been kept.');
  state.sensor?.stop();
  $('#camera-setup').classList.remove('hidden');
  $('#align').classList.add('hidden');
  updateControls();
}
$('#stop-camera').addEventListener('click', () => { stopCamera(); link.send({ t: 'idle' }); say('Camera stopped.'); });
$('#lock-camera').addEventListener('click', async () => {
  if (!state.sensor?.running || state.mode) return;
  state.mode = 'camera-lock'; updateControls();
  try {
    const locked = await state.sensor.lockCamera();
    $('#cam-caps').textContent = Object.entries(locked).map(([key, value]) =>
      `${key === 'whiteBalance' ? 'white balance' : key}: ${value ? 'locked' : 'automatic / unconfirmed'}`).join(', ');
    say('Camera modes checked. A lock is shown only when confirmed by the camera.');
  } catch (error) { say(error.message, true); }
  finally { state.mode = null; updateControls(); }
});
let lastReadout = 0;
function onLiveFrame(event) {
  const frame = event.detail;
  if (!frame || performance.now() - lastReadout < 160) return;
  lastReadout = performance.now();
  if (state.mode !== 'tune') $('#live-ratio').textContent = frame.ratio.map(v => v.toFixed(3)).join('  ');
  const clipped = frame.clipping > 0.02;
  const dark = frame.anchor.luma < 0.0001;
  const noisy = frame.noise > 0.1;
  $('#live-quality').textContent = clipped ? 'clipping' : dark ? 'too dark' : noisy ? 'check alignment' : 'sampling';
  $('#live-quality').className = 'mono ' + (clipped || dark || noisy ? 'bad' : 'good');
  $('#align-hint').textContent = clipped ? 'Reduce monitor brightness or camera exposure; highlights are clipping.'
    : dark ? 'The reference is too dark to measure reliably.'
      : noisy ? 'Check that each circle is inside its patch. Dark patches can also be noisy.'
        : 'Keep the phone steady. A stable ratio alone does not establish accuracy.';
}

function syncPreview() {
  const sensor = state.sensor;
  if (!sensor) return;
  const w = sensor.video.videoWidth || 16, h = sensor.video.videoHeight || 9;
  $('#camera-viewport').style.aspectRatio = `${w} / ${h}`;
  for (const role of ['anchor', 'test']) {
    const node = $(`#reticles [data-role="${role}"]`);
    if (node) place(node, sensor.regions[role]);
  }
  placeBounds();
}
function place(node, region) {
  const rect = $('#reticles').getBoundingClientRect();
  const diameter = region.r * 2 * Math.min(rect.width, rect.height);
  node.style.left = `${region.x * 100}%`; node.style.top = `${region.y * 100}%`;
  node.style.width = `${diameter}px`; node.style.height = `${diameter}px`;
  node.setAttribute('aria-label', `${node.dataset.role} sample, ${Math.round(region.x * 100)} percent across, ${Math.round(region.y * 100)} percent down. Use arrow keys to move.`);
}
function moveRegion(role, x, y) {
  const region = state.sensor.regions[role], rect = $('#reticles').getBoundingClientRect();
  const radius = region.r * Math.min(rect.width, rect.height);
  region.x = clamp(x, radius / rect.width, 1 - radius / rect.width);
  region.y = clamp(y, radius / rect.height, 1 - radius / rect.height);
  place($(`#reticles [data-role="${role}"]`), region);
}
function bindReticles() {
  const layer = $('#reticles'); layer.replaceChildren();
  for (const role of ['anchor', 'test']) {
    const node = document.createElement('div');
    node.className = 'reticle'; node.dataset.role = role; node.tabIndex = 0;
    node.setAttribute('role', 'button');
    const label = document.createElement('span'); label.textContent = role; node.appendChild(label);
    layer.appendChild(node);
    let dragging = false;
    node.addEventListener('pointerdown', event => {
      if (state.mode) return;
      dragging = true; node.setPointerCapture(event.pointerId); event.preventDefault();
    });
    node.addEventListener('pointermove', event => {
      if (!dragging || state.mode) return;
      const rect = layer.getBoundingClientRect();
      moveRegion(role, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, () => { dragging = false; });
    node.addEventListener('keydown', event => {
      if (state.mode || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); const r = state.sensor.regions[role], step = event.shiftKey ? 0.03 : 0.005;
      moveRegion(role, r.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
        r.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
    });
  }
}
$('#reticle-size').addEventListener('input', event => {
  if (!state.sensor || state.mode) return;
  for (const role of ['anchor', 'test']) {
    const reg = state.sensor.regions[role]; reg.r = Number(event.target.value) / 1000;
    moveRegion(role, reg.x, reg.y);
  }
});
new ResizeObserver(syncPreview).observe($('#camera-viewport'));

for (const target of Object.values(TARGETS)) {
  const option = document.createElement('option'); option.value = target.id; option.textContent = target.name; $('#target').appendChild(option);
}
for (const run of Object.values(RUNS)) {
  const option = document.createElement('option'); option.value = run.id;
  option.textContent = `${run.name} (${run.build().length} patches)`; $('#run-type').appendChild(option);
}
$('#target').value = state.target; $('#run-type').value = state.run;
$('#target').addEventListener('change', event => { state.target = event.target.value; link.send({ t: 'target', target: state.target }); });
$('#run-type').addEventListener('change', event => { state.run = event.target.value; });

async function operate(mode, work) {
  if (state.mode) return;
  if (!state.sensor?.running) return say('Start the camera first.', true);
  if (link.state !== 'open') return say('Reconnect to the display first.', true);
  const controller = new AbortController();
  state.controller = controller; state.mode = mode; updateControls();
  try { await work(controller.signal); }
  catch (error) { say(error.message, error.name !== 'AbortError'); }
  finally {
    if (mode === 'run' && state.readings.length) {
      saveLastSession(snapshot()); link.send({ t: 'results', ...snapshot() });
    }
    link.send({ t: 'idle' });
    $('#screen-bounds').classList.add('hidden'); $('#capture-uniformity').classList.add('hidden');
    if (state.controller === controller) { state.controller = null; state.mode = null; }
    updateControls();
  }
}
$('#tune').addEventListener('click', () => operate('tune', async signal => {
  await render({ test: [0.8, 0.8, 0.8], anchor: 0.5, label: 'Relative grey balance' }, signal);
  say('Relative channel drift between 80% and 50% grey. This does not measure D65 or prescribe RGB gain changes.');
  while (!signal.aborted) {
    const m = await state.sensor.measure({ settleMs: 150, minSamples: 12, tolerance: 0.012, maxMs: 2500, signal });
    const avg = m.ratio.reduce((sum, v) => sum + v, 0) / 3;
    if (avg < 1e-6) throw new Error('The comparison patch is too dark.');
    if (m.clipping > 0.02 || !m.converged) throw new Error('The live comparison is clipped or unstable. Check the camera and retry.');
    const balance = m.ratio.map(v => (v / avg - 1) * 100);
    link.send({ t: 'live', balance, stability: m.stability });
    $('#live-ratio').textContent = balance.map(v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`).join('  ');
  }
}));
$('#run').addEventListener('click', () => operate('run', async signal => {
  const patches = RUNS[state.run].build();
  state.readings = []; state.uniformity = state.flicker = null;
  state.resultTarget = state.target; state.complete = false;
  state.expected = patches.length; state.sessionId = newSessionId();
  link.send({ t: 'run-start', sessionId: state.sessionId, expected: patches.length, target: state.resultTarget });
  progress(0, patches.length, 'Starting');
  let flagged = 0;
  for (const [index, patch] of patches.entries()) {
    throwIfAborted(signal);
    say(`${index + 1} of ${patches.length}: ${patch.label}`);
    await render(patch, signal);
    let result = await state.sensor.measure({ settleMs: index === 0 ? 1600 : 800, signal });
    if (readingIssues({ patch, result }).length) {
      say(`Rechecking ${patch.label}: the first reading failed quality checks.`);
      const retry = await state.sensor.measure({ settleMs: 1000, signal });
      if (readingIssues({ patch, result: retry }).length <= readingIssues({ patch, result }).length) result = retry;
    }
    throwIfAborted(signal);
    const reading = { patch, result };
    if (readingIssues(reading).length) flagged++;
    state.readings.push(reading);
    saveLastSession(snapshot());
    progress(index + 1, patches.length, patch.label);
  }
  state.complete = true;
  say(flagged ? `Run finished with ${flagged} flagged reading(s). Correction export is blocked; review the monitor report.`
    : 'Run complete. Review the monitor report before applying any experimental correction.', flagged > 0);
}));

function placeBounds() {
  const b = state.bounds, node = $('#screen-bounds');
  node.style.left = `${b.x * 100}%`; node.style.top = `${b.y * 100}%`;
  node.style.width = `${b.w * 100}%`; node.style.height = `${b.h * 100}%`;
}
for (const corner of ['tl', 'br']) {
  const handle = $(`#screen-bounds [data-corner="${corner}"]`);
  let active = false;
  function move(x, y) {
    const b = state.bounds, right = b.x + b.w, bottom = b.y + b.h;
    if (corner === 'tl') { b.x = clamp(x, 0, right - 0.15); b.y = clamp(y, 0, bottom - 0.15); b.w = right - b.x; b.h = bottom - b.y; }
    else { b.w = clamp(x - b.x, 0.15, 1 - b.x); b.h = clamp(y - b.y, 0.15, 1 - b.y); }
    placeBounds();
  }
  handle.addEventListener('pointerdown', event => { active = true; handle.setPointerCapture(event.pointerId); event.preventDefault(); });
  handle.addEventListener('pointermove', event => {
    if (!active) return;
    const r = $('#camera-viewport').getBoundingClientRect(); move((event.clientX - r.left) / r.width, (event.clientY - r.top) / r.height);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, () => { active = false; });
  handle.addEventListener('keydown', event => {
    if (!event.key.startsWith('Arrow')) return;
    event.preventDefault(); const b = state.bounds;
    move((corner === 'tl' ? b.x : b.x + b.w) + (event.key === 'ArrowLeft' ? -0.01 : event.key === 'ArrowRight' ? 0.01 : 0),
      (corner === 'tl' ? b.y : b.y + b.h) + (event.key === 'ArrowUp' ? -0.01 : event.key === 'ArrowDown' ? 0.01 : 0));
  });
}
function awaitCapture(signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError(signal.reason));
    const cleanup = () => { $('#capture-uniformity').removeEventListener('click', capture); signal.removeEventListener('abort', aborted); };
    const capture = () => { cleanup(); resolve(); };
    const aborted = () => { cleanup(); reject(abortError(signal.reason)); };
    $('#capture-uniformity').addEventListener('click', capture, { once: true });
    signal.addEventListener('abort', aborted, { once: true });
  });
}
$('#uniformity').addEventListener('click', () => operate('uniformity', async signal => {
  await render(uniformityFrame(0.5), signal);
  $('#screen-bounds').classList.remove('hidden'); $('#capture-uniformity').classList.remove('hidden');
  $('#capture-uniformity').disabled = false; placeBounds();
  say('Face the screen straight on. Drag the rectangle corners to the grey field edges, then tap Capture uniformity.');
  await awaitCapture(signal); $('#capture-uniformity').disabled = true;
  await delay(1000, signal);
  state.uniformity = state.sensor.uniformityGrid(5, 5, state.bounds);
  if (!state.readings.length) state.resultTarget = state.target;
  saveLastSession(snapshot()); link.send({ t: 'results', ...snapshot() });
  say(`Worst sampled zone: ${state.uniformity.worstDeviation.toFixed(1)}% from centre. Lens shading and viewing angle are included.`);
}));
$('#flicker').addEventListener('click', () => operate('flicker', async signal => {
  await render({ test: [0.5, 0.5, 0.5], anchor: 0.5, label: 'Temporal modulation' }, signal);
  say('Measuring temporal variation. Keep the phone still; this cannot identify PWM frequency.');
  state.flicker = await state.sensor.flickerScan(5000, { signal });
  if (!state.readings.length) state.resultTarget = state.target;
  saveLastSession(snapshot()); link.send({ t: 'results', ...snapshot() });
  say(`${(state.flicker.modulationDepth * 100).toFixed(1)}% modulation at ${state.flicker.sampleHz.toFixed(0)} samples/s. ${state.flicker.verdict}.`);
}));
$('#save-phone-session').addEventListener('click', () => {
  try { download(sessionBlob(snapshot()), 'lumen-session.json'); } catch (error) { say(error.message, true); }
});
let wakeLock = null;
async function holdWake() {
  if (wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancel('Measurement stopped because the camera page was hidden. Partial readings were kept.'); wakeLock?.release(); }
  else holdWake();
});
window.addEventListener('pagehide', () => { cancel('Page closed.'); state.sensor?.stop(); link.destroy(); wakeLock?.release(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') cancel(); });
holdWake(); updateControls();
// Read-only-by-convention diagnostics for local debugging and browser regression tests.
window.lumen = { state, link };
