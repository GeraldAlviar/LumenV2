import { TARGETS } from './patches.js?v=2.2.0';
import { MODES } from './modes.js?v=2.2.0';
import { assessReadings } from './quality.js?v=2.2.0';
import { analyseGreyscale, analyseGamut, scorecard } from './analysis.js?v=2.2.0';

import { analyseVerification, compareVerification } from './verification.js?v=2.2.0';

export function repeatability(readings) {
  const comparisons = [];
  for (const r of readings.filter(r => r.patch.kind === 'repeat')) {
    const p = r.patch;
    const original = readings.find(a => a.patch.kind === p.sourceKind && a.patch.anchor === p.anchor && JSON.stringify(a.patch.test) === JSON.stringify(p.test));
    if (!original) continue;
    const deviation = Math.max(...r.result.ratio.map((v, i) => Math.abs(v - original.result.ratio[i]) / Math.max(original.result.ratio[i], 0.005)));
    comparisons.push(deviation);
  }
  return comparisons.length ? { count: comparisons.length, worst: Math.max(...comparisons), mean: comparisons.reduce((a, b) => a + b, 0) / comparisons.length } : null;
}
export function makeReport(data) {
  const readings = data.readings || [], target = TARGETS[data.target] || TARGETS.gamma22;
  const mode = MODES[data.run], quality = assessReadings(readings, data);
  const kinds = new Set(readings.map(r => r.patch.kind));
  let grey = null, gamut = null;
  try { if (kinds.has('grey') && data.purpose !== 'verification') grey = analyseGreyscale(readings, target); }
  catch (e) { quality.warnings.push(e.message); quality.canExport = false; }
  try { if (kinds.has('gamut') || kinds.has('memory')) gamut = analyseGamut(readings, target); }
  catch (e) { quality.warnings.push(e.message); quality.canExport = false; }
  const repeat = repeatability(readings), t = data.telemetry || {};
  const verification = analyseVerification(data), comparison = compareVerification(data.comparison, data);
  const diagnosticOnly = data.capture?.diagnosticOnly === true;
  for (const w of data.capture?.warnings || []) quality.warnings.push(`${w.accepted ? 'Accepted warning' : 'Capture note'}: ${w.title}. ${w.detail}`);
  let score = 100;
  score -= Math.min(24, (t.retries || 0) * 2) + Math.min(15, (t.movements || 0) * 3) + Math.min(10, (t.disconnects || 0) * 3);
  if (t.exposureLocked !== true) { score = Math.min(score, 69); quality.warnings.push('Exposure lock was not confirmed by this camera. Stable ratios cannot remove all automatic camera processing.'); }
  if (t.whiteBalanceLocked !== true) { score = Math.min(score, 79); quality.warnings.push('White balance lock was not confirmed. Colour and channel-drift results remain approximate.'); }
  if (data.alignment?.automatic === false) { score = Math.min(score, 69); quality.warnings.push('Sampling used the manual square guide; automatic alignment was not confirmed.'); }
  if (data.alignment?.grade === 'Fair') score = Math.min(score, 79);
  if (!t.motionEnabled && !t.visualTracking && data.run) quality.warnings.push('Automatic movement monitoring was unavailable. A phone stand is especially important.');
  if (repeat && repeat.worst > 0.08) { score = Math.min(score, 44); quality.warnings.push('Repeated patches differed by more than 8%; experimental correction export is blocked.'); quality.canExport = false; }
  if ((t.referenceDrift || 0) > 0.05) score = Math.min(score, 69);
  if ((t.referenceDrift || 0) > 0.08) { quality.canExport = false; quality.warnings.push('Repeated reference drift exceeded 8%. No automatic compensation was applied.'); }
  if (t.exposureLocked !== true || t.whiteBalanceLocked !== true) quality.canExport = false;
  if (t.trackingDisabled) { score = Math.min(score, 69); quality.warnings.push('Visual movement pauses were disabled. Fixed sampling positions were not protected by automatic tracking.'); }
  if (diagnosticOnly) { score = Math.min(score, 49); quality.canExport = false; quality.warnings.unshift('DIAGNOSTIC ONLY: you chose to continue capture warnings. Values are uncertain; ICC/CAL correction exports are disabled.'); }
  if (data.purpose === 'verification') { quality.canExport = false; quality.warnings.push('A verification run checks fresh held-out tones. It does not supply a new calibration dataset.'); }
  if (quality.unreliable.length || !data.complete) score = Math.min(score, 44);
  let grade = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Fair' : 'Poor';
  if (grade === 'Poor') quality.canExport = false;
  if (data.synthetic) { grade = 'Demo'; quality.canExport = false; quality.warnings.unshift('SIMULATED DATA: no display was measured. Correction exports are disabled.'); }
  const name = mode?.name || 'this test';
  const notMeasured = (key, included) => data.omissions?.[key] || (data.purpose === 'verification' ? 'Not measured in this fresh verification check. See the original full report.' : null) || (included ? 'Not measured: the required readings are missing or the test was interrupted.' : `Not measured in ${name}.`);
  const coverage = [
    { name: 'Greyscale / gamma', measured: Boolean(grey), note: grey ? `${grey.points.length} grey levels. Relative tone response, not absolute luminance.` : notMeasured('grey', true) },
    { name: 'Relative channel balance', measured: Boolean(grey), note: grey ? 'Channel tracking across grey levels. Not an absolute white-point measurement.' : notMeasured('grey', true) },
    { name: 'Black / apparent contrast', measured: Boolean(grey), note: grey ? 'Camera-limited estimate. Unresolved black does not prove high contrast.' : notMeasured('grey', true) },
    { name: 'Colour response', measured: Boolean(gamut), note: gamut ? 'Camera-response indices, not Delta E or gamut coverage.' : notMeasured('colour', data.run !== 'quick') },
    { name: 'Held-out tonal check', measured: Boolean(verification), note: verification ? `${verification.points.length} tones not used to fit the correction curve; mean camera-relative error ${verification.meanAbsError.toFixed(2)} percentage points. This is a check, not proof that calibration was applied.` : 'Not measured: this saved report has no usable held-out tones.' },
    { name: 'Reference drift checks', measured: (t.referenceChecks || 0) > 0, note: (t.referenceChecks || 0) > 0 ? `${t.referenceChecks} repeated reference captures. Worst observed ratio change ${((t.referenceDrift || 0) * 100).toFixed(1)}%. Exposure and white balance may still be automatic.` : 'Not measured: no periodic references in this saved report.' },
    { name: 'Before / after verification', measured: Boolean(comparison?.count), note: comparison ? comparison.status + '. ' + comparison.message : 'Not measured yet. After making adjustments yourself, run a fresh verification from the phone report.' },
    { name: 'Repeatability', measured: Boolean(repeat), note: repeat ? `${repeat.count} repeated patches; largest ratio difference ${(repeat.worst * 100).toFixed(1)}%.` : notMeasured('repeatability', ['detailed', 'full'].includes(data.run)) },
    { name: 'Field uniformity', measured: Boolean(data.uniformity), note: data.uniformity ? 'Visible display field only. Lens shading, angle and reflections are included.' : notMeasured('uniformity', Boolean(mode?.uniformity)) },
    { name: 'Temporal variation', measured: Boolean(data.flicker), note: data.flicker ? 'Frame-rate-limited camera variation. This is not a PWM/flicker-frequency measurement.' : notMeasured('temporal', Boolean(mode?.temporal)) },
    { name: 'Absolute luminance, white point and gamut', measured: false, note: 'Not measured in any phone-only mode. A calibrated reference instrument is required.' },
  ];
  for (const c of coverage) c.status = !c.measured ? 'Not measured' : diagnosticOnly || quality.unreliable.length ? 'Uncertain estimate' : 'Camera-relative estimate';
  const recommendations = [];
  if (!data.complete || grade === 'Poor') recommendations.push('Resolve the capture warnings and repeat the test before changing monitor settings or using a correction file.');
  if (grey && Number.isFinite(grey.gamma) && data.displaySetup?.controls?.includes('gamma') && !diagnosticOnly) {
    const difference = grey.gamma - target.gamma;
    recommendations.push(Math.abs(difference) > 0.12 && target.eotf !== 'srgb'
      ? `The estimated gamma is ${grey.gamma.toFixed(2)} versus the ${target.gamma.toFixed(1)} target. Try a ${difference > 0 ? 'lower' : 'higher'} gamma preset on the monitor, then run a fresh test. Preset names vary by monitor.`
      : 'Review the tone-response curve. Do not change settings solely to chase a small camera-derived difference.');
  }
  recommendations.push('Set comfortable monitor brightness before measuring. No cd/m2 value or reliable brightness-slider number is measured here. Changing brightness, contrast or picture mode requires a new test.');
  recommendations.push('Keep HDR, dynamic contrast, adaptive brightness and colour-temperature automation off during this SDR comparison. Keep room lighting steady.');
  recommendations.push('RGB/channel results show relative tracking, not D65/D50. Do not use these readings to prescribe absolute RGB-gain steps.');
  if (data.uniformity) recommendations.push('Treat non-uniform areas as a prompt to inspect the screen visually: the phone lens and viewing angle can also cause this pattern.');
  recommendations.push(quality.canExport ? 'Experimental ICC/CAL curves are available after acknowledgement. Save the current profile first; the app does not install or apply a profile.'
    : 'Raw JSON and CSV remain available. ICC/CAL are blocked until sufficient, complete measurements pass the quality gates.');
  quality.warnings = [...new Set(quality.warnings)];
  return { target, mode, grey, gamut, quality, grade, score, repeat, verification, comparison, diagnosticOnly, coverage, recommendations,
    rows: scorecard(grey, gamut, data.uniformity, data.flicker, target) };
}
