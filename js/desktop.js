// Display rendering and reports; camera images never cross the device link.
import { createLink, makeRoomCode } from './net.js';
import { hex, clamp } from './colour.js';
import { TARGETS } from './patches.js';
import { analyseGreyscale, analyseGamut, scorecard, buildCorrectionLut } from './analysis.js';
import { buildIccProfile, buildArgyllCal, buildCsv, download } from './icc.js';
import { assessReadings } from './quality.js';
import { validateResults, MAX_SESSION_BYTES } from './validation.js';
import { sessionBlob, parseSession, saveLastSession, SESSION_KEY } from './session.js';
import { syntheticReadings } from './demo.js';

const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const link = createLink();
const state = {
  code: null, pairUrl: '', target: TARGETS.gamma22, readings: [],
  grey: null, gamut: null, uniformity: null, flicker: null,
  complete: false, expected: 0, sessionId: '', synthetic: false, activeRun: false,
  quality: { canExport: false, warnings: [], unreliable: [] },
};
const surround = $('#surround'), anchorEl = $('#patch-anchor'), testEl = $('#patch-test'), fieldEl = $('#patch-field');
const toSignalCss = values => hex(values.map(v => clamp(v, 0, 1) * 255));
function renderPatch(msg) {
  fieldEl.classList.add('hidden');
  document.body.classList.add('measuring');
  if (msg.layout === 'field') {
    anchorEl.classList.add('hidden'); testEl.classList.add('hidden'); fieldEl.classList.remove('hidden');
    fieldEl.replaceChildren();
    for (let i = 0; i < 25; i++) { const cell = el('div'); cell.style.background = toSignalCss(msg.test); fieldEl.appendChild(cell); }
    surround.style.background = '#000';
  } else {
    anchorEl.classList.remove('hidden'); testEl.classList.remove('hidden');
    anchorEl.style.background = toSignalCss([msg.anchor, msg.anchor, msg.anchor]);
    testEl.style.background = toSignalCss(msg.test);
    // This surround does not guarantee constant APL. Disable dynamic display
    // processing and treat OLED/local-dimming measurements as approximate.
    surround.style.background = toSignalCss(Array(3).fill(msg.anchor * 0.5));
  }
}
function showIdle() { document.body.classList.remove('measuring'); }
function setStatus(text, bad = false) { $('#status').textContent = text; $('#status').classList.toggle('bad', bad); }
async function startHosting() {
  $('#retry-host').disabled = true;
  state.code = makeRoomCode(); $('#room-code').textContent = state.code;
  const url = new URL('phone.html', location.href); url.search = ''; url.searchParams.set('room', state.code);
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
link.addEventListener('state', event => {
  const status = event.detail.state;
  if (status === 'open') {
    setStatus('Phone connected. Press Escape here to stop a test.');
    $('#pair-panel').classList.add('hidden');
    if ($('#report').classList.contains('hidden')) $('#live-panel').classList.remove('hidden');
    link.send({ t: 'hello' });
  }
  if (['closed', 'error'].includes(status)) {
    showIdle(); state.activeRun = false;
    $('#pair-panel').classList.remove('hidden');
    setStatus(event.detail.error || 'Phone disconnected. Reconnect with the code above.', true);
  }
});
link.addEventListener('notice', event => setStatus(event.detail));
link.addEventListener('message', event => {
  const msg = event.detail;
  switch (msg.t) {
    case 'render':
      if (document.hidden) { link.reply(msg, { t: 'error', error: 'Display tab is hidden. Bring it to the front.' }); break; }
      renderPatch(msg);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (document.hidden) link.reply(msg, { t: 'error', error: 'Display became hidden during patch rendering.' });
        else link.reply(msg, { t: 'rendered', at: performance.now() });
      }));
      break;
    case 'idle': showIdle(); break;
    case 'target':
      $('#target-name').textContent = TARGETS[msg.target].name;
      if (!state.readings.length && !state.uniformity && !state.flicker) state.target = TARGETS[msg.target];
      break;
    case 'run-start':
      resetReport(); state.activeRun = true; state.sessionId = msg.sessionId;
      state.target = TARGETS[msg.target]; state.expected = msg.expected;
      $('#live-panel').classList.remove('hidden'); break;
    case 'progress':
      $('#prog-bar').style.width = `${msg.done / msg.total * 100}%`;
      $('#prog-label').textContent = `${msg.done} of ${msg.total}: ${msg.label}`; break;
    case 'live': updateBridge(msg.balance, msg.stability); break;
    case 'results':
      if (state.activeRun && state.sessionId && msg.sessionId !== state.sessionId) break;
      try { ingestResults(msg); } catch (error) { setStatus(error.message, true); }
      break;
  }
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
    complete: state.complete, expected: state.expected, sessionId: state.sessionId, synthetic: state.synthetic };
}
function resetReport() {
  state.readings = []; state.grey = state.gamut = state.uniformity = state.flicker = null;
  state.complete = false; state.expected = 0; state.sessionId = ''; state.synthetic = false; state.activeRun = false;
  state.quality = { canExport: false, warnings: [], unreliable: [] };
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
  state.grey = state.gamut = null; // Never carry charts over from another run.
  state.quality = assessReadings(state.readings, state);
  const kinds = new Set(state.readings.map(r => r.patch.kind));
  try { if (kinds.has('grey')) state.grey = analyseGreyscale(state.readings, state.target); }
  catch (error) { state.quality.canExport = false; state.quality.warnings.push(error.message); }
  try { if (kinds.has('gamut') || kinds.has('memory')) state.gamut = analyseGamut(state.readings, state.target); }
  catch (error) { state.quality.canExport = false; state.quality.warnings.push(error.message); }
  if (state.synthetic) { state.quality.canExport = false; state.quality.warnings.unshift('SIMULATED DATA: this report does not describe your monitor. Correction downloads are disabled.'); }
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
  $('#report-title').textContent = state.target.name;
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
  $('#eotf-card').classList.toggle('hidden', !state.grey); $('#balance-card').classList.toggle('hidden', !state.grey);
  $('#chart-eotf').innerHTML = state.grey ? eotfChart(state.grey, state.target) : '';
  $('#chart-balance').innerHTML = state.grey ? balanceChart(state.grey) : '';
  if (state.uniformity) renderHeatmap(state.uniformity);
  else { $('#heatmap').replaceChildren(); $('#uniformity-note').textContent = 'Run the uniformity check on your phone, aligning the on-screen rectangle before capture.'; }
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
  try { localStorage.removeItem(SESSION_KEY); updateSavedTools(); setStatus('Saved browser copy cleared. The current report is unchanged.'); }
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
function interrupt(reason) { link.send({ t: 'interrupt', reason }); showIdle(); state.activeRun = false; }
document.addEventListener('visibilitychange', () => { if (document.hidden) interrupt('Display tab was hidden. Partial measurements have been kept.'); else holdWake(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape') interrupt('Stopped from the display. Partial measurements have been kept.'); });
let wakeLock = null;
async function holdWake() {
  if (wakeLock || document.hidden) return;
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => { wakeLock = null; }); } catch {}
}
window.addEventListener('pagehide', () => { link.destroy(); wakeLock?.release(); });
window.lumen = { state, link, ingest: ingestResults };
updateSavedTools(); updateExports(); holdWake();
if (new URLSearchParams(location.search).has('demo')) { $('#pair-panel').classList.add('hidden'); showDemo(); }
else startHosting();
