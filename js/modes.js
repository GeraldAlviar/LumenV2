import { ladderRun, flareRun, greyscaleRun, gamutRun, memoryColourRun, anchorFor } from './patches.js?v=2.2.0';

const repeat = patches => patches.map(p => ({ ...p, sourceKind: p.kind, kind: 'repeat', label: `Repeat: ${p.label}` }));
const references = () => [...ladderRun(), ...flareRun()];
export const MODES = {
  quick: {
    id: 'quick', name: 'Quick Check', estimate: '~45 sec', seconds: [30, 60],
    detail: '11 grey levels, reference ladder and black-response checks. No colour sweep or uniformity.',
    build: () => [...references(), ...greyscaleRun(11)],
    sample: { settleMs: 700, minSamples: 18, maxMs: 3200, tolerance: 0.015 },
    uniformity: false, temporal: false,
  },
  standard: {
    id: 'standard', name: 'Standard Test', estimate: '~2-3 min', seconds: [120, 180],
    detail: 'Recommended. 21 grey levels and 24 colour-response patches, plus reference checks.',
    build: () => [...references(), ...greyscaleRun(21), ...gamutRun()],
    sample: { settleMs: 1000, minSamples: 30, maxMs: 4500, tolerance: 0.01 },
    uniformity: false, temporal: false,
  },
  detailed: {
    id: 'detailed', name: 'Detailed Test', estimate: '~4-5 min', seconds: [240, 300],
    detail: '41 grey levels, colour probes, repeated greys and a conditional 3 x 3 field-uniformity check.',
    build: () => [...references(), ...greyscaleRun(41), ...gamutRun(), ...memoryColourRun(), ...repeat(greyscaleRun(41).filter((_, i) => i % 4 === 0))],
    sample: { settleMs: 1100, minSamples: 42, maxMs: 5000, tolerance: 0.008 },
    uniformity: 3, temporal: false,
  },
  full: {
    id: 'full', name: 'Full Test', estimate: '~7-10 min', seconds: [420, 600],
    detail: '61 grey levels, colour probes, repeated reference/grey/colour checks, conditional 5 x 5 uniformity and temporal variation. Use a phone stand.',
    build: () => [...references(), ...greyscaleRun(61), ...gamutRun(), ...memoryColourRun(),
      ...repeat([...ladderRun(), ...greyscaleRun(61).filter((_, i) => i % 2 === 0), ...memoryColourRun()])],
    sample: { settleMs: 1200, minSamples: 60, maxMs: 5500, tolerance: 0.006 },
    uniformity: 5, temporal: true,
  },
};
export const PLAN_VERSION = 2;
export const VERIFY_LEVELS = [0.13, 0.37, 0.63, 0.87];
export function verificationPatches() { return VERIFY_LEVELS.map(level => ({ kind: 'verification', level, test: [level, level, level], anchor: anchorFor(level), label: `Held-out grey ${Math.round(level * 100)}%` })); }
function insertReferences(patches, interval) {
  const out = [];
  const reference = () => ({ kind: 'reference', test: [0.75, 0.75, 0.75], anchor: 0.5, label: 'Repeated camera reference' });
  out.push(reference());
  patches.forEach((p, i) => { out.push(p); if ((i + 1) % interval === 0 && i !== patches.length - 1) out.push(reference()); });
  out.push(reference()); return out;
}
for (const mode of Object.values(MODES)) {
  const build = mode.build;
  mode.build = () => insertReferences([...build(), ...verificationPatches()], mode.id === 'quick' ? 12 : 10);
  mode.detail += ' Includes periodic drift references and four held-out tones.';
}
export function planFor(run, purpose = 'assessment') {
  if (purpose === 'verification') return insertReferences([...references(), ...greyscaleRun(2), ...verificationPatches()], 8);
  if (!MODES[run]) throw new Error('Unknown test mode.');
  return MODES[run].build();
}
export function modeFor(id) { return MODES[id] || MODES.standard; }
export function patchKey(p) {
  return JSON.stringify([p.kind, p.sourceKind || null, p.level ?? null, p.anchor, p.test, p.label]);
}
export function verifyResume(session) {
  const mode = MODES[session?.run];
  if (!mode || session.planVersion !== PLAN_VERSION || session.synthetic || session.complete)
    throw new Error('This saved report cannot be resumed. Its readings can still be opened or exported.');
  const plan = planFor(session.run, session.purpose);
  if (session.expected !== plan.length || session.readings.length > plan.length ||
      session.readings.some((r, i) => patchKey(r.patch) !== patchKey(plan[i])))
    throw new Error('Saved progress does not match this test plan. Start a new test; the old report is preserved.');
  return plan;
}
