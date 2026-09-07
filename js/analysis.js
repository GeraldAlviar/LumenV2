// analysis.js — turning raw ratios into numbers you can act on.

import {
  targetEotf, linearRgbToXyz, xyzToXy, cctFromXy, duvFromXy,
  xyzToLab, xyToXyz, deltaE2000, WHITE_POINTS, mean, clamp, linearToSrgb,
} from './colour.js';
import { ANCHORS } from './patches.js';

/* ---------- Stitching the anchor ladder ---------- */

// Each ladder reading says "this anchor is X times the one above it". Multiply
// the chain to get every anchor's brightness relative to full white, then every
// test patch measured against an anchor can be placed on that same scale.
export function buildLadderScale(readings) {
  const scale = new Map([[ANCHORS[0], [1, 1, 1]]]);
  for (let i = 1; i < ANCHORS.length; i++) {
    const step = readings.find(r => r.patch.kind === 'ladder' && r.patch.level === ANCHORS[i]);
    const prev = scale.get(ANCHORS[i - 1]);
    if (!step || step.patch.anchor !== ANCHORS[i - 1] ||
        !step.result.ratio.every(v => Number.isFinite(v) && v > 0)) {
      throw new Error(`Missing or invalid reference at ${ANCHORS[i] * 100}%. Rerun the measurement.`);
    }
    scale.set(ANCHORS[i], prev.map((v, c) => v * step.result.ratio[c]));
  }
  return scale;
}

// Fit stray light as a straight line against anchor brightness.
//
// Each black-patch reading is first placed on the common scale, giving
//     black_measured(A) = trueBlack + slope * A
// A least squares fit separates the two. The intercept is real display output
// and stays; the slope is lens flare and gets removed. Fitting rather than
// subtracting outright is the difference between a believable contrast ratio and
// a division by something very close to zero.
export function buildFlareMap(readings, scale) {
  const flares = readings.filter(r => r.patch.kind === 'flare');
  const slope = [0, 0, 0];
  if (flares.length >= 2) {
    for (let c = 0; c < 3; c++) {
      const pts = flares.map(r => ({
        x: scale.get(r.patch.anchor)[c],
        y: r.result.ratio[c] * scale.get(r.patch.anchor)[c],
      }));
      const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
      let num = 0, den = 0;
      pts.forEach(p => { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; });
      // A negative slope is physically impossible, so treat it as no flare
      // rather than letting fit noise add light back in.
      slope[c] = den > 0 ? Math.max(0, num / den) : 0;
    }
  }
  return { slope };
}

// Absolute-relative linear RGB for a patch: ratio to its anchor, scaled onto the
// ladder, with the anchor's stray light contribution removed.
export function resolveReading(reading, scale, flare) {
  const anchorScale = scale.get(reading.patch.anchor);
  if (!anchorScale) throw new Error('The reading uses an unmeasured reference.');
  const stray = flare.slope.map((s, c) => s * anchorScale[c]);
  return [0, 1, 2].map(c =>
    Math.max(0, reading.result.ratio[c] * anchorScale[c] - stray[c]));
}

/* ---------- Greyscale ---------- */

export function analyseGreyscale(readings, target) {
  const scale = buildLadderScale(readings);
  const flare = buildFlareMap(readings, scale);
  const greys = readings.filter(r => r.patch.kind === 'grey')
    .sort((a, b) => a.patch.level - b.patch.level);
  if (!greys.length) return null;
  if (greys[0].patch.level !== 0 || greys.at(-1).patch.level !== 1)
    throw new Error('Black and full-white readings are required. The report is incomplete.');
  if (new Set(greys.map(r => r.patch.level)).size !== greys.length)
    throw new Error('Duplicate greyscale levels in this session.');

  const resolved = greys.map(r => ({ level: r.patch.level, rgb: resolveReading(r, scale, flare) }));

  // White is defined as the 100% patch. Everything is normalised to it, which
  // means what gets reported is tracking error rather than absolute white point.
  // That distinction matters: tracking error is measured honestly, absolute
  // chromaticity is not knowable without a reference.
  const white = resolved[resolved.length - 1].rgb;
  if (white.some(v => !Number.isFinite(v) || v <= 1e-6)) throw new Error('Full white is invalid after correction. Check exposure and alignment.');
  const wY = 0.2126 * white[0] + 0.7152 * white[1] + 0.0722 * white[2];
  const black = resolved[0].rgb;
  const bY = 0.2126 * black[0] + 0.7152 * black[1] + 0.0722 * black[2];

  const points = resolved.map(p => {
    // Per-channel gains that would make this step neutral relative to white.
    const norm = [0, 1, 2].map(c => p.rgb[c] / Math.max(white[c], 1e-9));
    const Y = mean(norm);
    const measured = clamp((0.2126 * p.rgb[0] + 0.7152 * p.rgb[1] + 0.0722 * p.rgb[2]) / Math.max(wY, 1e-9), 0, 1.2);
    const wanted = targetEotf(p.level, target);
    // Balance error expressed as percentage deviation of each channel from the
    // mean of the three. This is the number the tuning bars respond to.
    const balance = norm.map(v => (v / Math.max(Y, 1e-9) - 1) * 100);
    const effGamma = p.level > 0.05 && p.level < 0.99 && measured > 1e-5
      ? Math.log(measured) / Math.log(p.level) : null;
    return {
      level: p.level,
      measured,
      target: wanted,
      errorPct: (measured - wanted) * 100,
      balance,
      effGamma,
      rgb: p.rgb,
    };
  });

  // Least squares power-law fit over the useful mid range.
  const blackRelative = bY / wY;
  const fit = points.filter(p => p.level >= 0.1 && p.level <= 0.9 && p.measured > blackRelative + 1e-5);
  let gamma = null;
  if (fit.length > 3) {
    const xs = fit.map(p => Math.log(p.level));
    const ys = fit.map(p => Math.log((p.measured - blackRelative) / Math.max(1 - blackRelative, 1e-9)));
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < xs.length; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      den += (xs[i] - mx) ** 2;
    }
    gamma = den ? num / den : null;
  }

  const contrast = bY > 1e-7 ? wY / bY : Infinity;
  const worstBalance = Math.max(...points.filter(p => p.level >= 0.2)
    .flatMap(p => p.balance.map(Math.abs)));

  return {
    points,
    gamma,
    gammaError: gamma === null ? null : gamma - target.gamma,
    contrast,
    worstBalance,
    meanAbsError: mean(points.map(p => Math.abs(p.errorPct))),
    white, black,
  };
}

/* ---------- White point and tuning guidance ---------- */

// Legacy numerical helper, not used to prescribe monitor gain changes.
// A shared multiplicative monitor gain cancels in a test/reference ratio.
// The UI therefore presents relative channel drift, not white-point tuning.
export function tuningAdvice(balance, currentGains = { r: 50, g: 50, b: 50 }) {
  // Most monitor gain controls move roughly 1.2% output per step near centre.
  const STEP_PCT = 1.2;
  const worst = Math.max(...balance.map(Math.abs));
  const names = ['Red', 'Green', 'Blue'];
  const keys = ['r', 'g', 'b'];
  const moves = balance.map((err, i) => {
    const steps = Math.round(-err / STEP_PCT);
    return {
      channel: names[i],
      key: keys[i],
      errorPct: err,
      steps,
      from: currentGains[keys[i]],
      to: clamp(currentGains[keys[i]] + steps, 0, 100),
      direction: steps === 0 ? 'hold' : steps > 0 ? 'up' : 'down',
    };
  });
  // Never raise a channel if one can be lowered instead; headroom is finite and
  // clipping a gain control costs more than it fixes.
  const maxSteps = Math.max(...moves.map(m => m.steps));
  if (maxSteps > 0) moves.forEach(m => { m.steps -= maxSteps; m.to = clamp(m.from + m.steps, 0, 100); m.direction = m.steps === 0 ? 'hold' : m.steps > 0 ? 'up' : 'down'; });
  return {
    moves,
    worst,
    verdict: worst < 1 ? 'Neutral' : worst < 2 ? 'Close' : worst < 4 ? 'Visible cast' : 'Strong cast',
  };
}

// Estimated white point, flagged clearly as an estimate. Without a reference the
// camera's own spectral response biases this, and pretending otherwise would be
// dishonest. It is useful for tracking drift over time, not for certification.
export function estimateWhitePoint(linearRgb, cameraMatrix = null) {
  const xyz = cameraMatrix ? applyMatrix(cameraMatrix, linearRgb) : linearRgbToXyz(linearRgb);
  const [x, y] = xyzToXy(xyz);
  return {
    x, y,
    cct: cctFromXy(x, y),
    duv: duvFromXy(x, y),
    referenced: Boolean(cameraMatrix),
  };
}

function applyMatrix(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/* ---------- Gamut ---------- */

export function analyseGamut(readings, target) {
  const scale = buildLadderScale(readings);
  const flare = buildFlareMap(readings, scale);
  const wp = WHITE_POINTS[target.white];
  const wXyz = xyToXyz(wp[0], wp[1], 1);
  const items = readings.filter(r => ['gamut', 'memory'].includes(r.patch.kind)).map(r => {
    const lin = resolveReading(r, scale, flare);
    const measuredXyz = linearRgbToXyz(lin);
    const wantedXyz = linearRgbToXyz(r.patch.test.map(v => targetEotf(v, target)));
    const dE = deltaE2000(xyzToLab(measuredXyz, wXyz), xyzToLab(wantedXyz, wXyz));
    return { label: r.patch.label, kind: r.patch.kind, hue: r.patch.hue, sat: r.patch.sat, deltaE: dE };
  });
  return {
    items,
    meanDeltaE: items.length ? mean(items.map(i => i.deltaE)) : null,
    maxDeltaE: items.length ? Math.max(...items.map(i => i.deltaE)) : null,
    // Below 1.0 is invisible, below 2.0 is invisible unless the two colours are
    // touching, above 3.0 is obvious.
    pass: null, // A camera-space difference cannot certify display colour accuracy.
  };
}

/* ---------- Correction curves ---------- */

// Build a 256-entry per-channel LUT that maps requested signal to corrected
// signal, so the measured output lands on the target curve.
// Pool adjacent violators in signal order. Sorting noisy measurements by output
// instead can invert input order and produce a non-monotonic correction curve.
export function isotonic(values) {
  const blocks = [];
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) throw new Error('Non-finite response sample.');
    blocks.push({ start: index, end: index, sum: value, count: 1 });
    while (blocks.length > 1) {
      const b = blocks.at(-1), a = blocks.at(-2);
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(-2, 2, { start: a.start, end: b.end, sum: a.sum + b.sum, count: a.count + b.count });
    }
  });
  const out = new Array(values.length);
  blocks.forEach(b => { for (let i = b.start; i <= b.end; i++) out[i] = b.sum / b.count; });
  return out;
}

export function buildCorrectionLut(greyscale, target, entries = 256) {
  if (!Number.isInteger(entries) || entries < 2 || entries > 65535) throw new Error('Invalid LUT size.');
  const pts = greyscale?.points?.slice().sort((a, b) => a.level - b.level);
  if (!pts || pts.length < 6 || pts[0].level !== 0 || pts.at(-1).level !== 1)
    throw new Error('A complete greyscale is required for correction export.');
  const lut = {};
  ['r', 'g', 'b'].forEach((ch, ci) => {
    const white = greyscale.white[ci];
    if (!Number.isFinite(white) || white <= 0) throw new Error('Invalid white reference.');
    const outputs = isotonic(pts.map(p => clamp(p.rgb[ci] / white, 0, 1)));
    const samples = pts.map((p, i) => ({ in: p.level, out: outputs[i] }));
    lut[ch] = Float64Array.from({ length: entries }, (_, i) =>
      clamp(invert(samples, targetEotf(i / (entries - 1), target)), 0, 1));
    lut[ch][0] = 0;
    lut[ch][entries - 1] = 1;
  });
  return lut;
}

function invert(samples, wantedOut) {
  if (wantedOut <= samples[0].out) return samples[0].in;
  const last = samples[samples.length - 1];
  if (wantedOut >= last.out) return last.in;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].out >= wantedOut) {
      const a = samples[i - 1], b = samples[i];
      const t = (wantedOut - a.out) / Math.max(b.out - a.out, 1e-12);
      return a.in + t * (b.in - a.in);
    }
  }
  return last.in;
}

/* ---------- Verdicts ---------- */

export function scorecard(grey, gamut, uniformity, flicker, target) {
  const rows = [];
  const band = (v, good, ok) => (v <= good ? 'good' : v <= ok ? 'ok' : 'poor');

  if (grey) {
    rows.push({
      metric: 'Fitted gamma', value: grey.gamma === null ? 'Not enough data' : grey.gamma.toFixed(2),
      note: target.eotf === 'srgb' ? 'sRGB is piecewise; this power fit is descriptive only' : `target ${target.gamma.toFixed(2)}; black-normalised camera fit`,
      status: grey.gamma === null || target.eotf === 'srgb' ? 'estimate' : band(Math.abs(grey.gammaError), 0.05, 0.12),
    });
    rows.push({
      metric: 'Greyscale tracking', value: `${grey.meanAbsError.toFixed(2)}%`,
      note: 'mean deviation from target curve',
      status: band(grey.meanAbsError, 1.5, 3),
    });
    rows.push({
      metric: 'White balance drift', value: `${grey.worstBalance.toFixed(1)}%`,
      note: 'worst channel imbalance above 20% signal',
      status: band(grey.worstBalance, 2, 4),
    });
    const unresolved = !Number.isFinite(grey.contrast) || grey.contrast > 3000;
    rows.push({
      metric: 'Apparent contrast', value: unresolved ? 'Unresolved' : `${Math.round(grey.contrast)}:1`,
      note: unresolved ? 'Black is near the camera/model floor; no lower bound is established'
        : 'Estimate; affected by ambient light, camera offsets and stray-light fitting',
      status: 'estimate',
    });
  }
  if (gamut && gamut.meanDeltaE != null) {
    rows.push({
      metric: 'Camera colour response', value: `Index ${gamut.meanDeltaE.toFixed(1)}`,
      note: 'Unreferenced camera-space difference, not display Delta E or gamut coverage',
      status: 'estimate',
    });
  }
  if (uniformity) {
    rows.push({
      metric: 'Backlight uniformity', value: `${uniformity.worstDeviation.toFixed(1)}%`,
      note: 'Against centre; lens shading and viewing angle are not removed',
      status: 'estimate',
    });
  }
  if (flicker) {
    rows.push({
      metric: 'Temporal modulation', value: `${(flicker.modulationDepth * 100).toFixed(1)}%`,
      note: flicker.verdict,
      status: 'estimate',
    });
  }
  return rows;
}

export { linearToSrgb };
