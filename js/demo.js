// Deterministic, idealised fixtures. Never treat these as monitor measurements.
import { fullRun } from './patches.js?v=2.2.0';
export function syntheticReadings(patches = fullRun(), gamma = 2.35, black = 0.001) {
  const output = (v, c) => black + (1 - black) * v ** (gamma + [0.025, 0, -0.02][c]);
  return patches.map(patch => {
    const anchor = [0, 1, 2].map(c => output(patch.anchor, c));
    const test = patch.test.map((v, c) => output(v, c));
    const ratio = test.map((v, c) => v / anchor[c]);
    // Camera exposure changes by patch; both regions receive the same gain.
    const gain = 0.7 / Math.max(...anchor, ...test);
    return { patch, result: {
      ratio, lumaRatio: ratio.reduce((s, v) => s + v, 0) / 3,
      stability: 0.001, clipping: 0, noise: 0.01, samples: 24, converged: true,
      anchorLinear: anchor.map(v => v * gain), testLinear: test.map(v => v * gain),
    } };
  });
}
