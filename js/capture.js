// Capture warnings and correction eligibility are deliberately separate.
// A diagnostic override never upgrades bad data into a calibration measurement.
import { validReading } from './validation.js?v=2.2.0';
import { readingIssues } from './quality.js?v=2.2.0';

export function issue(code, title, detail, severity = 'warning') {
  return { code, title, detail, severity };
}
export class CaptureError extends Error {
  constructor(issues) {
    super(issues.map(i => i.title + ': ' + i.detail).join(' ').slice(0, 500));
    this.name = 'CaptureError'; this.issues = issues;
  }
}
export function captureIssues(reading) {
  if (!validReading(reading)) return [issue('invalid', 'No usable camera reading', 'Restart the camera. Missing or non-finite data cannot be continued.', 'blocker')];
  const m = reading.result;
  const issues = [];
  if (m.clipping >= 0.5) issues.push(issue('clipping-severe', 'The sample is severely overexposed', 'At least half the sampled pixels are clipped. Retry exposure or reposition the sample away from reflections. If you change monitor brightness, start a new test.', 'blocker'));
  else if (m.clipping > 0.02) issues.push(issue('clipping', 'Some sampled pixels are clipping', `${(m.clipping * 100).toFixed(1)}% reached the camera limit. Retry exposure, check the sample positions, or continue for a diagnostic report only.`));
  if (Math.max(...m.anchorLinear) < 0.00001) issues.push(issue('no-signal', 'The reference sample is too dark to read', 'Put the left sample inside the lit reference patch. A missing reference cannot be used for a measurement.', 'blocker'));
  else if (Math.min(...m.anchorLinear) < 0.0001) issues.push(issue('weak-reference', 'The reference is close to the camera noise floor', 'Check the left sampling area. Dark-level results will be uncertain.'));
  if (!m.converged || m.stability > 0.02) issues.push(issue('unstable', 'The camera has not fully settled', 'Rest the phone and keep room lighting steady. You may continue with these readings marked as uncertain.'));
  if (m.samples < 12) issues.push(issue('few-frames', 'Only a few camera frames were received', 'Keep Safari visible. This is not enough evidence for a correction file.'));
  if ((m.exposureDrift || 0) > 0.04) issues.push(issue('exposure-drift', 'Camera exposure changed during capture', 'Safari may be adjusting exposure. Retry or continue with reduced confidence; Lumen cannot force unsupported manual controls.'));
  if (m.noise > 0.15 && (reading.patch.level ?? 1) >= 0.1) issues.push(issue('noise', 'The sample is noisy or crosses a patch edge', 'Keep the small sample squares inside their patches. Manual corner selection can help; perfect guide overlap is not required.'));
  return issues;
}
export function blockers(issues = []) { return issues.filter(i => i.severity === 'blocker'); }
export function rememberWarnings(session, issues, stage = 'capture', accepted = false) {
  session.capture ||= { diagnosticOnly: false, warnings: [] };
  if (accepted) session.capture.diagnosticOnly = true;
  for (const item of issues) {
    if (session.capture.warnings.some(w => w.code === item.code && w.stage === stage && w.accepted === accepted)) continue;
    if (session.capture.warnings.length >= 64) break;
    session.capture.warnings.push({ code: item.code, title: item.title.slice(0, 150), detail: item.detail.slice(0, 500), stage: stage.slice(0, 80), accepted });
  }
}
export function referenceDrift(result, baseline) {
  if (!baseline?.ratio) return 0;
  return Math.max(...result.ratio.map((v, i) => Math.abs(v / Math.max(baseline.ratio[i], 0.005) - 1)));
}
// Export auditing always keeps the original, conservative checks.
export function auditReading(reading) { return readingIssues(reading); }
