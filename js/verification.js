// Held-out tones never enter the grey-response fit or correction LUT.
// These checks remain camera-relative; they are NOT Delta E, nits or D65 tests.
import { TARGETS } from './patches.js?v=2.2.0';
import { buildLadderScale, buildFlareMap, resolveReading } from './analysis.js?v=2.2.0';
import { targetEotf } from './colour.js?v=2.2.0';
import { readingIssues } from './quality.js?v=2.2.0';
const luma = rgb => .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2];
export function analyseVerification(data) {
  const patches = data.readings.filter(r => r.patch.kind === 'verification');
  if (!patches.length) return null;
  try {
    const scale = buildLadderScale(data.readings), flare = buildFlareMap(data.readings, scale);
    const white = data.readings.find(r => r.patch.kind === 'grey' && r.patch.level === 1);
    if (!white) return null;
    const whiteY = luma(resolveReading(white, scale, flare));
    if (!Number.isFinite(whiteY) || whiteY <= 0.000001) return null;
    const target = TARGETS[data.target];
    const points = patches.map(r => {
      const measured = luma(resolveReading(r, scale, flare)) / whiteY;
      const wanted = targetEotf(r.patch.level, target);
      return { level: r.patch.level, measured, wanted, error: (measured - wanted) * 100 };
    });
    if (points.some(p => !Number.isFinite(p.error) || p.measured > 1e6)) return null;
    const dependencies = data.readings.filter(r => ['ladder', 'flare', 'verification'].includes(r.patch.kind) || r.patch.kind === 'grey' && r.patch.level === 1);
    return { points, meanAbsError: points.reduce((s, p) => s + Math.abs(p.error), 0) / points.length,
      reliable: !data.synthetic && data.complete && !data.capture?.diagnosticOnly && data.telemetry?.exposureLocked === true && data.telemetry?.whiteBalanceLocked === true && !dependencies.some(r => readingIssues(r).length) && (data.telemetry?.referenceDrift || 0) <= 0.08 };
  } catch { return null; }
}
export function comparisonBaseline(session, action = 'recheck', note = '') {
  const summary = analyseVerification(session);
  if (!session.complete || session.synthetic || !summary) throw new Error('Finish a real test with held-out tone readings before starting a comparison.');
  return { sourceSessionId: session.sessionId, createdAt: session.createdAt, target: session.target,
    action, note: String(note).slice(0, 500), before: summary };
}
export function compareVerification(comparison, current) {
  if (!comparison) return null;
  if (!current.complete) return { status: 'Not measured', message: 'The fresh verification run has not finished. The saved baseline remains available.' };
  const after = analyseVerification(current);
  if (!after || comparison.target !== current.target) return { status: 'Not measured', message: 'The new check is incomplete or uses a different target.' };
  const pairs = after.points.map(p => [comparison.before.points.find(b => b.level === p.level), p]).filter(([b]) => b);
  if (pairs.length < 3) return { status: 'Not comparable', message: 'There are too few matching held-out tones.' };
  const beforeError = pairs.reduce((s, [b]) => s + Math.abs(b.error), 0) / pairs.length;
  const afterError = pairs.reduce((s, [, a]) => s + Math.abs(a.error), 0) / pairs.length;
  const change = beforeError - afterError;
  const reliable = comparison.before.reliable && after.reliable;
  const status = change > 0.5 ? 'Apparent tone error decreased' : change < -0.5 ? 'Apparent tone error increased' : 'No clear tonal change';
  return { status, beforeError, afterError, change, count: pairs.length, reliable,
    message: `${pairs.length} freshly measured tones compared with the saved baseline. ${reliable ? 'Camera-relative comparison only; not certified colour accuracy.' : 'Low-confidence comparison: camera settings or capture quality were not confirmed. Do not treat a numerical change as proof of improvement.'} This does not confirm that an operating-system profile was installed.` };
}
