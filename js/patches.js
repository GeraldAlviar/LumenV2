// patches.js — what gets shown, in what order, and why.

// Only transfer curves actually implemented by this renderer are offered.
// D50 white-point calibration and Display P3 gamut profiling need a reference
// and a colour-managed wide-gamut pipeline; changing a label does not add them.
export const TARGETS = {
  srgb: { id: 'srgb', name: 'sRGB transfer curve', eotf: 'srgb', gamma: 2.2, white: 'D65' },
  gamma22: { id: 'gamma22', name: 'Gamma 2.2', eotf: 'power', gamma: 2.2, white: 'D65' },
  rec709: { id: 'rec709', name: 'Gamma 2.4 (zero-black BT.1886)', eotf: 'bt1886', gamma: 2.4, white: 'D65' },
};

// Adjacent references reduce the brightness gap between the test and anchor.
// Chaining these readings avoids assuming a nominal display gamma, but does
// not guarantee camera linearity or eliminate the camera's own noise floor.
export const ANCHORS = [1.0, 0.5, 0.25, 0.125, 0.0625];

export function anchorFor(level) {
  if (!Number.isFinite(level) || level < 0 || level > 1) throw new Error('Signal must be between 0 and 1.');
  // Choose the nearest reference at or above the test, not full white for
  // almost every patch. This keeps dark readings beside a dim reference.
  return [...ANCHORS].reverse().find(a => a >= level) ?? 1;
}

/* ---------- Sequences ---------- */

// 21-point greyscale at 5% steps. This is the run that produces the EOTF curve,
// the greyscale tracking error and the correction LUT.
export function greyscaleRun(steps = 21) {
  if (!Number.isInteger(steps) || steps < 2 || steps > 101) throw new Error('Choose 2 to 101 greyscale steps.');
  const out = [];
  for (let i = 0; i < steps; i++) {
    const level = i / (steps - 1);
    out.push({
      kind: 'grey',
      level,
      label: `Grey ${Math.round(level * 100)}%`,
      test: [level, level, level],
      anchor: anchorFor(Math.max(level, 0.02)),
    });
  }
  return out;
}

// Ladder calibration: each anchor against the one above it.
export function ladderRun() {
  const out = [];
  for (let i = 1; i < ANCHORS.length; i++) {
    out.push({
      kind: 'ladder',
      level: ANCHORS[i],
      label: `Ladder ${Math.round(ANCHORS[i] * 100)}% vs ${Math.round(ANCHORS[i - 1] * 100)}%`,
      test: [ANCHORS[i], ANCHORS[i], ANCHORS[i]],
      anchor: ANCHORS[i - 1],
    });
  }
  return out;
}

// Black patches beside several references support an approximate stray-light
// fit. Ambient light, sensor black offset and display black cannot be fully
// separated without a calibrated instrument.
export function flareRun() {
  return ANCHORS.map(a => ({
    kind: 'flare',
    level: 0,
    label: `Stray light at ${Math.round(a * 100)}% anchor`,
    test: [0, 0, 0],
    anchor: a,
  }));
}

// Primaries, secondaries and saturation sweeps at 25/50/75/100%.
export function gamutRun() {
  const base = {
    Red: [1, 0, 0], Green: [0, 1, 0], Blue: [0, 0, 1],
    Cyan: [0, 1, 1], Magenta: [1, 0, 1], Yellow: [1, 1, 0],
  };
  const out = [];
  for (const [name, rgb] of Object.entries(base)) {
    for (const sat of [0.25, 0.5, 0.75, 1.0]) {
      const mixed = rgb.map(c => c * sat + (1 - sat) * 0.5);
      out.push({
        kind: 'gamut',
        label: `${name} ${Math.round(sat * 100)}%`,
        hue: name,
        sat,
        test: mixed,
        anchor: 0.5,
      });
    }
  }
  return out;
}

// Additional colour-response probes. These are not spectral references.
export function memoryColourRun() {
  const set = [
    ['Light skin', [0.784, 0.635, 0.537]],
    ['Deep skin', [0.400, 0.278, 0.216]],
    ['Foliage', [0.345, 0.427, 0.243]],
    ['Sky', [0.400, 0.529, 0.702]],
    ['Neutral 8', [0.788, 0.788, 0.788]],
    ['Neutral 5', [0.478, 0.478, 0.478]],
    ['Neutral 3.5', [0.290, 0.290, 0.290]],
  ];
  return set.map(([label, test]) => ({
    kind: 'memory', label, test, anchor: 0.5,
  }));
}

// One mid-grey field sampled within manually aligned rectangular bounds.
// Lens shading and viewing angle are not corrected by this diagnostic.
export function uniformityFrame(level = 0.5) {
  return { kind: 'uniformity', label: 'Uniformity field', test: [level, level, level], layout: 'field' };
}

export function fullRun() {
  return [...ladderRun(), ...flareRun(), ...greyscaleRun(), ...gamutRun(), ...memoryColourRun()];
}

export function quickRun() {
  return [
    ...ladderRun(),
    ...flareRun(),
    ...greyscaleRun(11),
  ];
}

export const RUNS = {
  quick: { id: 'quick', name: 'Quick greyscale', build: quickRun, mins: '~3 min' },
  full: { id: 'full', name: 'Full experimental check', build: fullRun, mins: '~12 min' },
  grey: { id: 'grey', name: 'Greyscale only', build: () => [...ladderRun(), ...flareRun(), ...greyscaleRun()], mins: '~6 min' },
  gamut: { id: 'gamut', name: 'Camera colour response', build: () => [...ladderRun(), ...flareRun(), ...gamutRun(), ...memoryColourRun()], mins: '~7 min' },
};
