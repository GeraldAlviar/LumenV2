import { ANCHORS } from './patches.js?v=2.1.0';
import { validReading } from './validation.js?v=2.1.0';

// These are conservative software gates, not proof of photometric accuracy.
export function readingIssues(reading) {
  if (!validReading(reading)) return ['invalid measurement'];
  const m = reading.result, issues = [];
  if (!m.converged) issues.push('did not settle');
  if (m.samples < 12) issues.push('too few frames');
  if (m.clipping > 0.02) issues.push('camera clipping');
  if ((m.exposureDrift || 0) > 0.04) issues.push('exposure changing during capture');
  if (m.stability > 0.02) issues.push('unstable channel ratios');
  if (m.noise > 0.15 && (reading.patch.level ?? 1) >= 0.1) issues.push('noisy or misaligned patch');
  if (Math.min(...m.anchorLinear) < 0.0001) issues.push('reference near sensor floor');
  return issues;
}

export function assessReadings(readings, { complete = true, expected = readings.length } = {}) {
  const warnings = [];
  if (!complete) warnings.push('This measurement was interrupted or is still in progress.');
  if (readings.length !== expected) warnings.push(`${readings.length} of ${expected} expected readings received.`);
  const unreliable = readings.map(r => ({ label: r.patch?.label || 'Unknown patch', issues: readingIssues(r) }))
    .filter(r => r.issues.length);
  if (unreliable.length) warnings.push(`${unreliable.length} reading(s) failed quality checks. Review the raw data and rerun.`);
  const greys = readings.filter(r => r.patch?.kind === 'grey');
  const levels = new Set(greys.map(r => r.patch.level));
  if (!levels.has(0) || !levels.has(1) || levels.size < 6)
    warnings.push('Correction export needs black, full white and at least six distinct grey levels.');
  if (levels.size !== greys.length) warnings.push('Duplicate grey levels were received.');
  for (let i = 1; i < ANCHORS.length; i++) {
    const steps = readings.filter(r => r.patch?.kind === 'ladder' && r.patch.level === ANCHORS[i]);
    if (steps.length !== 1 || steps[0].patch.anchor !== ANCHORS[i - 1])
      warnings.push(`Missing or duplicate reference at ${ANCHORS[i] * 100}%.`);
  }
  if (new Set(readings.filter(r => r.patch?.kind === 'flare').map(r => r.patch.anchor)).size < 2)
    warnings.push('At least two different stray-light references are required.');
  return { canExport: warnings.length === 0, warnings, unreliable, expected, received: readings.length };
}
