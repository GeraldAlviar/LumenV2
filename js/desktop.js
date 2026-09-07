// Display rendering and reports; camera images never cross the device link.
import { createLink, makeRoomCode } from './net.js?v=2.1.0';
import { hex, clamp } from './colour.js?v=2.1.0';
import { TARGETS } from './patches.js?v=2.1.0';
import { analyseGreyscale, analyseGamut, scorecard, buildCorrectionLut } from './analysis.js?v=2.1.0';
import { buildIccProfile, buildArgyllCal, buildCsv, download } from './icc.js?v=2.1.0';
import { assessReadings } from './quality.js?v=2.1.0';
import { validateResults, MAX_SESSION_BYTES } from './validation.js?v=2.1.0';
import { sessionBlob, parseSession, saveLastSession, SESSION_KEY } from './session.js?v=2.1.0';
import { syntheticReadings } from './demo.js?v=2.1.0';
import { DisplayStage } from './display.js?v=2.1.0';
import { BUILD, PROTOCOL, STAGES, formatTime } from './config.js?v=2.1.0';
import { makeReport } from './report.js?v=2.1.0';
import { verifyResume, MODES } from './modes.js?v=2.1.0';
import { createSession } from './session.js?v=2.1.0';
import { SessionStore, preference } from './storage.js?v=2.1.0';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const link = createLink();
const stage = new DisplayStage(), store = new SessionStore('monitor');
const events = [];
function log(kind, message) { events.push({ at: new Date().toISOString(), kind, message }); if (events.length > 300) events.shift(); }
const state = {
  compatible: false, backup: null, run: undefined, planVersion: 1, phase: 'idle', reason: '', telemetry: {}, omissions: {}, baseline: null, alignment: null, elapsedMs: 0, revision: -1, lastActivity: 0,
  code: null, pairUrl: '', target: TARGETS.gamma22, readings: [],
  grey: null, gamut: null, uniformity: null, flicker: null,
  complete: false, expected: 0, sessionId: '', synthetic: false, activeRun: false,
  quality: { canExport: false, warnings: [], unreliable: [] },
};
function showIdle() { stage.hide(); }
function setStatus(text, bad = false) { $('#status').textContent = text; $('#status').classList.toggle('bad', bad); }
async function startHosting() {
  $('#retry-host').disabled = true;
  state.code = makeRoomCode(); $('#room-code').textContent = state.code; $('#stage-room').textContent = `Reconnect code: ${state.code}`;
  const url = new URL('phone.html', location.href); url.search = ''; url.searchParams.set('room', state.code); url.searchParams.set('v', BUILD);
  state.pairUrl = url.href;
  $('#pair-url').textContent = url.href.replace(/^https?:\/\//, '');
  const box = $('#qr'); box.replaceChildren();
  if (globalThis.QRious) {
    try {
      const qr = new QRious({ value: url.href, size: 220, padding: 16, level: 'M' });
      box.appendChild(qr.canvas); box.classList.remove('hidden');
    } catch { box.classList.add('hidden'); }
  } else box.classList.add('hidden');
  try { await link.host(state.code); setStatus('Waiting for a phone. Keep this tab visible during measurement.'); }
  catch (error) { setStatus(error.message, true); }
  finally { $('#retry-host').disabled = false; }
}
$('#retry-host').addEventListener('click', startHosting);
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.pairUrl); setStatus('Pairing link copied.'); }
  catch { setStatus('Clipboard unavailable. Select and copy the pairing link shown above.'); }
});
function stageStatus(phase, label, progress) {
  $('#stage-phase').textContent = STAGES[phase] || (phase === 'ready' ? 'Ready to test' : phase === 'error' ? 'Action needed' : 'Align the square');
  $('#stage-status').textContent = label;
  $('#stage-hud').classList.toggle('attention', ['paused', 'stopped', 'error'].includes(phase));
  $('#stage-back').classList.toggle('hidden', !['paused', 'stopped', 'error'].includes(phase));
  if (progress) {
    const percent = phase === 'complete' ? 100 : Math.min(99, progress.done / progress.total * 100);
    $('#stage-count').textContent = `${progress.done} / ${progress.total}`;
    $('#stage-eta').textContent = ['paused', 'stopped'].includes(phase) ? 'Paused' : formatTime(progress.remaining) + ' left';
    $('#stage-bar').style.width = `${percent}%`; $('#prog-bar').style.width = `${percent}%`;
    $('#prog-label').textContent = `${progress.done} / ${progress.total}: ${label}`;
  }
  log(phase, label);
}
link.addEventListener('state', event => {
  const status = event.detail.state;
  if (status === 'open') {
    state.compatible = false; setStatus('Phone connected. Checking software version...');
    $('#pair-panel').classList.add('hidden');
    if ($('#report').classList.contains('hidden')) $('#live-panel').classList.remove('hidden');
  }
  if (['closed', 'error'].includes(status)) {
    state.compatible = false;
    const reason = event.detail.error || 'Phone disconnected. Reconnect with the code above.';
    if (state.activeRun) interrupt(reason, false);
    else showIdle();
    $('#pair-panel').classList.remove('hidden'); setStatus(reason, true);
  }
});
link.addEventListener('notice', event => setStatus(event.detail));
async function handleMessage(msg) {
  switch (msg.t) {
    case 'hello':
      state.compatible = msg.version === BUILD && msg.protocol === PROTOCOL;
      link.reply(msg, { t: 'hello', version: BUILD, protocol: PROTOCOL });
      setStatus(state.compatible ? `iPhone connected / v${BUILD}. Align the square on the phone. Escape pauses a test.` : 'Different Lumen versions detected. Refresh BOTH pages after updating.', !state.compatible);
      break;
    case 'render':
      if (!state.compatible) throw new Error('Refresh BOTH devices: their Lumen versions do not match.');
      if (msg.sessionId && (!state.activeRun || msg.sessionId !== state.sessionId)) throw new Error('This test is paused or no longer current. Realign and resume on the phone.');
      state.lastActivity = performance.now();
      link.reply(msg, { t: 'rendered', at: await stage.render(msg) });
      break;
    case 'setup':
      if (['error', 'aligning'].includes(msg.phase)) stage.pause();
      stageStatus(msg.phase, msg.label); setStatus(msg.label, msg.phase === 'error');
      break;
    case 'target':
      $('#target-name').textContent = TARGETS[msg.target].name;
      if (!state.activeRun && !state.readings.length) state.target = TARGETS[msg.target];
      break;
    case 'run-start':
      if (!MODES[msg.run] || MODES[msg.run].build().length !== msg.expected) throw new Error('The test plan does not match this build. Refresh both devices.');
      if (!state.compatible) throw new Error('Refresh BOTH devices to v' + BUILD + '.');
      if (state.sessionId !== msg.sessionId) resetReport();
      state.activeRun = true; state.revision = -1; state.sessionId = msg.sessionId;
      state.target = TARGETS[msg.target]; state.expected = msg.expected; state.run = msg.run;
      state.lastActivity = performance.now(); state.complete = false;
      $('#live-panel').classList.remove('hidden');
      stage.pause(); stageStatus('starting', 'Test accepted. Checking the camera before the first reading.');
      if (!state.backup || state.backup.sessionId !== msg.sessionId) {
        state.backup = createSession({ sessionId: msg.sessionId, target: msg.target, run: msg.run, planVersion: 1, readings: [], expected: msg.expected, phase: 'starting', complete: false });
        await store.save(state.backup);
      }
      link.reply(msg, { t: 'accepted', sessionId: msg.sessionId });
      break;
    case 'run-state':
      if (msg.sessionId !== state.sessionId || msg.revision <= state.revision) break;
      state.revision = msg.revision; state.lastActivity = performance.now(); state.elapsedMs = msg.elapsedMs; state.phase = msg.phase;
      stageStatus(msg.phase, msg.label, msg);
      if (['paused', 'stopped'].includes(msg.phase)) {
        state.activeRun = false; state.reason = msg.label; stage.pause(); setStatus(msg.label, true);
        if (state.backup?.sessionId === msg.sessionId) { state.backup.phase = msg.phase; state.backup.reason = msg.label; await store.save(state.backup); }
      }
      break;
    case 'checkpoint': {
      const session = createSession(validateResults(msg.session));
      if (session.sessionId !== state.sessionId || session.expected !== state.expected || session.target !== state.target.id) throw new Error('Checkpoint belongs to a different test. Reconnect and recover the saved session.');
      if (session.readings.length < state.readings.length) throw new Error('Out-of-order checkpoint rejected; newer readings are already saved.');
      verifyResume({ ...session, complete: false });
      state.readings = session.readings; state.backup = session;
      const saved = await store.save(session);
      $('#stage-storage').textContent = saved.saved ? `${session.readings.length} readings saved on monitor (${saved.backend}).` : 'Monitor storage unavailable. Keep this page open and save JSON.';
      link.reply(msg, { t: 'accepted', sessionId: session.sessionId });
      updateSavedTools();
      if (session.complete) ingestResults(session);
      break;
    }
    case 'recover':
      if (!state.compatible) throw new Error('Refresh both devices to the same version before recovering.');
      link.reply(msg, { t: 'recover', session: state.backup && !state.backup.complete && !state.backup.synthetic ? state.backup : null });
      break;
    case 'idle':
      // Legacy/generic idle must not erase an in-flight failure or progress.
      if (!state.activeRun && !['paused', 'stopped'].includes(state.phase)) showIdle();
      break;
    case 'progress': break; // v2 uses versioned run-state messages with phases.
    case 'live': updateBridge(msg.balance, msg.stability); break;
    case 'results':
      if (state.sessionId && msg.sessionId !== state.sessionId) break;
      ingestResults(msg); break;
  }
}
link.addEventListener('message', event => {
  const msg = event.detail;
  handleMessage(msg).catch(error => {
    link.reply(msg, { t: 'error', error: error.message.slice(0, 200) });
    setStatus(error.message, true); stageStatus('error', error.message); log('error', error.message);
  });
});
function updateBridge(balance, stability) {
  $('#bridge').classList.remove('hidden');
  ['r', 'g', 'b'].forEach((ch, index) => {
    const needle = $(`#needle-${ch}`);
    needle.style.left = `${50 + clamp(balance[index], -6, 6) / 6 * 48}%`;
    needle.dataset.v = `${balance[index] >= 0 ? '+' : ''}${balance[index].toFixed(1)}%`;
  });
  const worst = Math.max(...balance.map(Math.abs));
  $('#bridge-verdict').textContent = worst < 2 ? 'Close relative tracking' : 'Relative channel drift';
  $('#bridge-verdict').className = 'verdict';
  $('#bridge-stability').textContent = `Channel variation ${(stability * 100).toFixed(2)}%`;
}
function snapshot() {
  return { target: state.target.id, readings: state.readings, uniformity: state.uniformity, flicker: state.flicker,
    complete: state.complete, expected: state.expected, sessionId: state.sessionId, synthetic: state.synthetic,
    ...(state.run ? { run: state.run, planVersion: 1 } : {}), phase: state.phase, reason: state.reason, telemetry: state.telemetry,
    omissions: state.omissions, baseline: state.baseline, alignment: state.alignment, elapsedMs: state.elapsedMs };
}
function resetReport() {
  state.readings = []; state.grey = state.gamut = state.uniformity = state.flicker = null;
  state.complete = false; state.expected = 0; state.sessionId = ''; state.synthetic = false; state.activeRun = false;
  state.quality = { canExport: false, warnings: [], unreliable: [] };
  state.run = undefined; state.telemetry = {}; state.omissions = {}; state.baseline = null; state.alignment = null; state.reason = ''; state.phase = 'idle'; state.elapsedMs = 0;
  $('#accept-experimental').checked = false; $('#report').classList.add('hidden');
  $('#chart-eotf').replaceChildren(); $('#chart-balance').replaceChildren(); $('#heatmap').replaceChildren();
  $('#bridge').classList.add('hidden'); updateExports();
}
function ingestResults(message) {
  const msg = validateResults(message);
  if (msg.readings !== undefined) state.readings = msg.readings;
  if ('uniformity' in msg) state.uniformity = msg.uniformity;
  if ('flicker' in msg) state.flicker = msg.flicker;
  state.target = TARGETS[msg.target] || state.target;
  state.complete = msg.complete ?? false;
  state.expected = msg.expected ?? state.readings.length;
  state.sessionId = msg.sessionId || state.sessionId;
  state.synthetic = msg.synthetic === true;
  state.activeRun = false;
  state.run = msg.run; state.telemetry = msg.telemetry || {}; state.omissions = msg.omissions || {};
  state.baseline = msg.baseline || null; state.alignment = msg.alignment || null; state.elapsedMs = msg.elapsedMs || 0;
  state.phase = msg.phase || (state.complete ? 'complete' : 'paused'); state.reason = msg.reason || '';
  const report = makeReport(snapshot());
  state.grey = report.grey; state.gamut = report.gamut; state.quality = report.quality; state.report = report;
  $('#accept-experimental').checked = false;
  showIdle(); renderReport();
  if (!state.synthetic && (state.readings.length || state.uniformity || state.flicker)) {
    if (!saveLastSession(snapshot())) setStatus('Report ready. Browser storage is unavailable; save the JSON file to keep it.', true);
  }
  updateSavedTools();
}
function renderReport() {
  $('#report').classList.remove('hidden'); $('#live-panel').classList.add('hidden');
  $('#report-label').textContent = state.synthetic ? 'SIMULATED DATA / DEMO' : 'Experimental camera measurement';
  $('#report-title').textContent = `${state.report?.mode?.name || 'Measurement report'} / ${state.target.name}`;
  $('#measurement-grade').textContent = state.report.grade;
  $('#measurement-grade').className = state.report.grade === 'Poor' ? 'bad' : state.report.grade === 'Fair' ? 'warning' : 'good';
  $('#report-coverage').replaceChildren(...state.report.coverage.map(c => { const box = el('div', 'coverage-item' + (c.measured ? '' : ' not-measured')), title = el('strong', null, c.name), status = el('span', 'pill ' + (c.measured ? 'good' : 'estimate'), c.measured ? 'Measured' : 'Not measured'); box.append(title, status, el('p', 'small dim', c.note)); return box; }));
  $('#report-advice').replaceChildren(...state.report.recommendations.map(text => el('p', null, text)));
  $('#report-summary').textContent = `${state.readings.length} / ${state.expected} readings. ${state.complete ? 'Run finished.' : 'Partial run or standalone diagnostic.'} Absolute white point, luminance and gamut coverage are not measured.`;
  $('#quality-summary').textContent = state.quality.canExport
    ? 'Readings passed the software quality checks. Correction export is available after acknowledging the limitations.'
    : 'Correction export is unavailable for this session. Raw data can still be saved.';
  $('#quality-warnings').replaceChildren(...state.quality.warnings.map(text => el('li', null, text)));
  $('#quality-details').classList.toggle('hidden', !state.quality.unreliable.length);
  $('#quality-issues').replaceChildren(...state.quality.unreliable.map(r => el('li', null, `${r.label}: ${r.issues.join(', ')}`)));
  const rows = scorecard(state.grey, state.gamut, state.uniformity, state.flicker, state.target);
  const body = $('#score-body'); body.replaceChildren();
  for (const row of rows) {
    const tr = el('tr'); tr.appendChild(el('td', null, row.metric)); tr.appendChild(el('td', 'num', row.value));
    const td = el('td'), status = state.quality.unreliable.length ? 'estimate' : row.status;
    td.appendChild(el('span', 'pill ' + status, { good: 'on target', ok: 'review', poor: 'off target', estimate: 'estimate' }[status]));
    tr.appendChild(td); tr.appendChild(el('td', 'dim small', row.note)); body.appendChild(tr);
  }
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'dim', 'Not enough valid reference data for a report. Save the session or rerun.'); td.colSpan = 4; tr.appendChild(td); body.appendChild(tr); }
  $('#eotf-card').classList.remove('hidden'); $('#balance-card').classList.remove('hidden');
  $('#chart-eotf').innerHTML = state.grey ? eotfChart(state.grey, state.target) : '<p class=dim>Not measured: sufficient greyscale references are unavailable.</p>';
  $('#chart-balance').innerHTML = state.grey ? balanceChart(state.grey) : '<p class=dim>Not measured: sufficient greyscale references are unavailable.</p>';
  if (state.uniformity) renderHeatmap(state.uniformity);
  else { $('#heatmap').replaceChildren(); $('#uniformity-note').textContent = state.report.coverage.find(c => c.name === 'Field uniformity').note; }
  updateExports();
}
function eotfChart(grey, target) {
  const W = 460, H = 240, P = 34;
  const x = v => P + v * (W - P * 2);
  // Deviation from target in percent, which is the only view where a good
  // result looks like a flat line and a bad one is obvious.
  const errs = grey.points.map(p => p.errorPct);
  const lim = Math.max(3, Math.ceil(Math.max(...errs.map(Math.abs))));
  const y = v => H - P - ((v + lim) / (lim * 2)) * (H - P * 2);

  let g = '';
  for (let t = -lim; t <= lim; t += lim / 2) {
    g += `<line class="grid-line" x1="${P}" y1="${y(t).toFixed(1)}" x2="${W - P}" y2="${y(t).toFixed(1)}"/>`;
    g += `<text x="${P - 5}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${t > 0 ? '+' : ''}${t.toFixed(1)}</text>`;
  }
  for (let v = 0; v <= 1.001; v += 0.25) {
    g += `<text x="${x(v).toFixed(1)}" y="${H - P + 14}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }
  const path = grey.points.map((p, i) =>
    `${i ? 'L' : 'M'}${x(p.level).toFixed(1)},${y(p.errorPct).toFixed(1)}`).join(' ');
  const dots = grey.points.map(p =>
    `<circle cx="${x(p.level).toFixed(1)}" cy="${y(p.errorPct).toFixed(1)}" r="2.4" fill="var(--amber)"/>`).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Luminance deviation from target across the greyscale">
    ${g}
    <line class="axis" x1="${P}" y1="${y(0)}" x2="${W - P}" y2="${y(0)}" stroke="var(--signal)" stroke-dasharray="3 3"/>
    <path d="${path}" fill="none" stroke="var(--amber)" stroke-width="1.6"/>
    ${dots}
    <text x="${W / 2}" y="14" text-anchor="middle" fill="var(--dim)">Luminance error against ${target.name} (%)</text>
  </svg>`;
}

function balanceChart(grey) {
  const W = 460, H = 220, P = 34;
  const x = v => P + v * (W - P * 2);
  const all = grey.points.flatMap(p => p.balance);
  const lim = Math.max(3, Math.ceil(Math.max(...all.map(Math.abs))));
  const y = v => H - P - ((v + lim) / (lim * 2)) * (H - P * 2);
  const colours = ['#ff5b5b', '#4ade80', '#6aa8ff'];

  let g = '';
  for (let t = -lim; t <= lim; t += lim / 2) {
    g += `<line class="grid-line" x1="${P}" y1="${y(t).toFixed(1)}" x2="${W - P}" y2="${y(t).toFixed(1)}"/>`;
    g += `<text x="${P - 5}" y="${(y(t) + 3).toFixed(1)}" text-anchor="end">${t > 0 ? '+' : ''}${t.toFixed(1)}</text>`;
  }
  for (let v = 0; v <= 1.001; v += 0.25) {
    g += `<text x="${x(v).toFixed(1)}" y="${H - P + 14}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }
  const lines = [0, 1, 2].map(c => {
    const d = grey.points.filter(p => p.level > 0.04)
      .map((p, i) => `${i ? 'L' : 'M'}${x(p.level).toFixed(1)},${y(clamp(p.balance[c], -lim, lim)).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${colours[c]}" stroke-width="1.6"/>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Per channel white balance drift across the greyscale">
    ${g}
    <line class="axis" x1="${P}" y1="${y(0)}" x2="${W - P}" y2="${y(0)}" stroke="var(--signal)" stroke-dasharray="3 3"/>
    ${lines}
    <text x="${W / 2}" y="14" text-anchor="middle" fill="var(--dim)">Channel drift from neutral (%)</text>
  </svg>`;
}

function renderHeatmap(u) {
  const box = $('#heatmap');
  box.innerHTML = '';
  box.style.gridTemplateColumns = `repeat(${u.cols}, 1fr)`;
  u.cells.forEach(c => {
    const d = el('div');
    const dev = c.deviation;
    const mag = Math.min(Math.abs(dev) / 20, 1);
    d.style.background = dev < 0
      ? `rgba(90, 130, 255, ${0.12 + mag * 0.7})`
      : `rgba(255, 159, 28, ${0.12 + mag * 0.7})`;
    d.textContent = `${dev >= 0 ? '+' : ''}${dev.toFixed(0)}`;
    d.style.color = mag > 0.5 ? '#08080a' : 'var(--ink)';
    box.appendChild(d);
  });
  $('#uniformity-note').innerHTML =
    `Worst zone sits ${u.worstDeviation.toFixed(1)}% from centre. Spread across the panel is ${u.spread.toFixed(1)}%. `
    + `<span style="color:#5a82ff">Blue</span> is dimmer than centre, <span style="color:var(--amber)">amber</span> is brighter. `
    + `This includes camera lens shading, perspective and viewing-angle effects; it is not an isolated backlight measurement.`;
}

function updateExports() {
  const canExport = state.grey && state.quality.canExport && !state.synthetic;
  const accepted = $('#accept-experimental').checked;
  $('#dl-icc').disabled = !canExport || !accepted; $('#dl-cal').disabled = !canExport || !accepted;
  $('#dl-csv').disabled = !state.readings.length;
  $('#dl-json').disabled = !state.readings.length && !state.uniformity && !state.flicker;
  $('#accept-experimental').disabled = !canExport;
  $('#export-note').textContent = !canExport ? 'A complete, quality-checked greyscale is required. Demo data cannot be used for correction.'
    : accepted ? 'Export is enabled. These curves do not constitute a measured display profile.'
      : 'Acknowledge the limitations above to enable the experimental correction downloads.';
}
$('#accept-experimental').addEventListener('change', updateExports);
function guardedExport(callback) {
  try {
    if (!state.grey || !state.quality.canExport || state.synthetic || !$('#accept-experimental').checked)
      throw new Error('Correction export is blocked. Review the data-quality notes and acknowledgement.');
    callback(buildCorrectionLut(state.grey, state.target));
  } catch (error) { setStatus(error.message, true); }
}
$('#dl-icc').addEventListener('click', () => guardedExport(lut => {
  const name = `Lumen experimental ${state.target.id} ${new Date().toISOString().slice(0, 10)}`;
  download(buildIccProfile({ description: name, lut, target: state.target }), name.replace(/[^\w.-]+/g, '-') + '.icc');
}));
$('#dl-cal').addEventListener('click', () => guardedExport(lut => download(buildArgyllCal(lut), 'lumen-experimental.cal')));
$('#dl-csv').addEventListener('click', () => {
  try { download(buildCsv(state.readings, state.grey), 'lumen-measurements.csv'); } catch (error) { setStatus(error.message, true); }
});
$('#dl-json').addEventListener('click', () => {
  try { download(sessionBlob(snapshot()), 'lumen-session.json'); } catch (error) { setStatus(error.message, true); }
});
function updateSavedTools() {
  let present = false;
  try { present = Boolean(localStorage.getItem(SESSION_KEY)); } catch {}
  $('#restore-session').classList.toggle('hidden', !present); $('#clear-saved').classList.toggle('hidden', !present);
}
function loadSession(text) {
  if (state.activeRun) throw new Error('Stop the active measurement before opening another session.');
  ingestResults(parseSession(text)); setStatus('Saved session opened. Analysis was recomputed from the raw readings.');
}
$('#open-session').addEventListener('click', () => $('#session-file').click());
$('#session-file').addEventListener('change', async event => {
  const file = event.target.files?.[0];
  try { if (!file) return; if (file.size > MAX_SESSION_BYTES) throw new Error('Session file exceeds the 2 MB limit.'); loadSession(await file.text()); }
  catch (error) { setStatus(error.message, true); }
  finally { event.target.value = ''; }
});
$('#restore-session').addEventListener('click', () => {
  try { loadSession(localStorage.getItem(SESSION_KEY)); } catch (error) { setStatus(error.message, true); }
});
$('#clear-saved').addEventListener('click', () => {
  try { localStorage.removeItem(SESSION_KEY); store.clear().then(() => { state.backup = null; updateSavedTools(); }); updateSavedTools(); setStatus('Saved monitor copy cleared. The current report is unchanged.'); }
  catch { setStatus('Could not access browser storage.', true); }
});
function showDemo() {
  if (state.activeRun) { setStatus('Stop the active measurement before opening the demo.', true); return; }
  const readings = syntheticReadings();
  ingestResults({ readings, target: 'gamma22', complete: true, expected: readings.length, synthetic: true,
    uniformity: null, flicker: null, sessionId: 'demo' });
  setStatus('Demo: all values are simulated. No monitor has been measured.');
}
$('#demo-session').addEventListener('click', showDemo);
$('#restart').addEventListener('click', () => {
  resetReport(); link.send({ t: 'reset' });
  if (link.state === 'open') $('#live-panel').classList.remove('hidden');
  else $('#pair-panel').classList.remove('hidden');
  setStatus('Ready for a new measurement. Previously saved browser data is retained.');
});
$('#go-fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    else throw new Error('Fullscreen is unavailable in this browser.');
  } catch (error) { setStatus(error.message, true); }
});
document.addEventListener('fullscreenchange', () => { $('#go-fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; });
function interrupt(reason, notify = true) {
  if (notify) link.send({ t: 'interrupt', reason });
  state.activeRun = false; state.phase = 'paused'; state.reason = reason;
  stage.pause(); stageStatus('paused', reason); setStatus(reason, true);
  if (state.backup && !state.backup.complete) { state.backup.phase = 'paused'; state.backup.reason = reason; store.save(state.backup); }
}
$('#stage-back').addEventListener('click', () => {
  if (state.activeRun) return; stage.hide(); $('#pair-panel').classList.remove('hidden');
  setStatus('Saved progress is retained. Reconnect the phone, then realign and resume.');
});
$('#stage-stop').addEventListener('click', () => interrupt('Stopped from the monitor. Completed readings are saved; realign before resuming.'));
document.addEventListener('visibilitychange', () => { if (document.hidden && state.activeRun) interrupt('Monitor tab was hidden. Bring it back, realign and resume.'); else holdWake(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && state.activeRun) interrupt('Paused from the monitor. Realign and resume on your iPhone.'); });
window.addEventListener('resize', () => { if (state.activeRun) interrupt('Monitor viewport changed size. Realign the square and resume.'); });
setInterval(() => { if (state.activeRun && performance.now() - state.lastActivity > 16000) interrupt('The phone stopped sending test updates. Reconnect and resume; completed readings are saved.'); }, 1000);
$('#advanced').checked = preference('advanced') === '1';
function interfaceMode() { document.body.classList.toggle('advanced', $('#advanced').checked); preference('advanced', $('#advanced').checked ? '1' : '0'); }
$('#advanced').addEventListener('change', interfaceMode); interfaceMode();
$('#dl-log').addEventListener('click', () => download(new Blob([JSON.stringify({ build: BUILD, phase: state.phase, events }, null, 2)], { type: 'application/json' }), 'lumen-monitor-diagnostics.json'));
$('#print-report').addEventListener('click', () => window.print());
window.addEventListener('error', e => { if (e.message) { setStatus(e.message, true); if (state.activeRun) interrupt('Monitor error: ' + e.message); } });
window.addEventListener('unhandledrejection', e => { const reason = e.reason?.message || 'Unexpected monitor error'; setStatus(reason, true); if (state.activeRun) interrupt(reason); });
store.load().then(saved => { if (saved && !state.backup && !state.activeRun) { state.backup = saved; updateSavedTools(); } });
let wakeLock = null;
async function holdWake() {
  if (wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
window.addEventListener('pagehide', () => { link.destroy(); wakeLock?.release(); });
window.lumen = { state, link, stage, store, ingest: ingestResults };
updateSavedTools(); updateExports(); holdWake();
if (new URLSearchParams(location.search).has('demo')) { $('#pair-panel').classList.add('hidden'); showDemo(); }
else startHosting();
