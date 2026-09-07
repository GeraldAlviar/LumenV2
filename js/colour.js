// colour.js — photometric and colorimetric primitives.
// Everything here works in 0..1 normalised space unless stated otherwise.

/* ---------- Transfer functions ---------- */

// sRGB encoded (0..1) -> linear light. Cameras output sRGB-ish, so every
// sample must pass through here before any arithmetic is done on it.
export function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(v) {
  v = Math.max(0, Math.min(1, v));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// BT.1886 EOTF used for Rec.709 mastering targets.
export function bt1886(v, gamma = 2.4, lb = 0, lw = 1) {
  const a = Math.pow(Math.pow(lw, 1 / gamma) - Math.pow(lb, 1 / gamma), gamma);
  const b = Math.pow(lb, 1 / gamma) / (Math.pow(lw, 1 / gamma) - Math.pow(lb, 1 / gamma));
  return a * Math.pow(Math.max(0, v + b), gamma);
}

// Pure power law, the target most monitor OSDs are actually aiming at.
export function powerLaw(v, gamma = 2.2) {
  return Math.pow(Math.max(0, v), gamma);
}

// Returns the target relative luminance for a given signal level.
export function targetEotf(v, target) {
  switch (target.eotf) {
    case 'srgb': return srgbToLinear(v);
    case 'bt1886': return bt1886(v, target.gamma);
    default: return powerLaw(v, target.gamma);
  }
}

/* ---------- Matrices ---------- */

export const SRGB_TO_XYZ_D65 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];

export function mul3(m, v) {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function linearRgbToXyz(rgb, m = SRGB_TO_XYZ_D65) {
  return mul3(m, rgb);
}

export function xyzToXy(xyz) {
  const s = xyz[0] + xyz[1] + xyz[2];
  if (s <= 0) return [0, 0];
  return [xyz[0] / s, xyz[1] / s];
}

/* ---------- Correlated colour temperature ---------- */

// McCamy's cubic approximation. Accurate to about 2 K over 2856-6500 K,
// which is far tighter than anything a phone camera can resolve anyway.
export function cctFromXy(x, y) {
  const n = (x - 0.3320) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

// Distance from the Planckian locus in CIE 1960 uv. Positive is green,
// negative is magenta. This is the number that tells you whether a "6500 K"
// white is actually neutral or just sitting near the right temperature.
export function duvFromXy(x, y) {
  const d = -2 * x + 12 * y + 3;
  const u = 4 * x / d;
  const v = 6 * y / d;
  const k = [-0.471106, 1.925865, -2.4243787, 1.5317403, -0.5179722, 0.0893944, -0.00616793];
  const lfp = Math.hypot(u - 0.292, v - 0.24);
  const a = Math.acos((u - 0.292) / lfp);
  let lbb = 0;
  for (let i = 0; i < k.length; i++) lbb += k[i] * a ** i;
  return lfp - lbb;
}

// CIE D-series illuminant chromaticity for a nominal temperature.
export function dSeriesXy(cct) {
  let x;
  if (cct <= 7000) {
    x = 0.244063 + 0.09911e3 / cct + 2.9678e6 / cct ** 2 - 4.6070e9 / cct ** 3;
  } else {
    x = 0.237040 + 0.24748e3 / cct + 1.9018e6 / cct ** 2 - 2.0064e9 / cct ** 3;
  }
  const y = -3 * x * x + 2.870 * x - 0.275;
  return [x, y];
}

export const WHITE_POINTS = {
  D50: [0.34567, 0.35850],
  D55: [0.33242, 0.34743],
  D65: [0.31272, 0.32903],
  D75: [0.29902, 0.31485],
};

/* ---------- CIELAB and colour difference ---------- */

export function xyzToLab(xyz, wp) {
  const f = t => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(xyz[0] / wp[0]);
  const fy = f(xyz[1] / wp[1]);
  const fz = f(xyz[2] / wp[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function xyToXyz(x, y, Y = 1) {
  if (y === 0) return [0, 0, 0];
  return [x * Y / y, Y, (1 - x - y) * Y / y];
}

// CIEDE2000. Long but there is no shorter honest version.
export function deltaE2000(lab1, lab2) {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hp = (b, a) => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) * 180 / Math.PI;
    return h >= 0 ? h : h + 360;
  };
  const hp1 = hp(b1, ap1), hp2 = hp(b2, ap2);
  const dLp = L2 - L1;
  const dCp = Cp2 - Cp1;
  let dhp = 0;
  if (Cp1 * Cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin(dhp * Math.PI / 360);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (Cp1 + Cp2) / 2;
  let hbp;
  if (Cp1 * Cp2 === 0) hbp = hp1 + hp2;
  else if (Math.abs(hp1 - hp2) <= 180) hbp = (hp1 + hp2) / 2;
  else hbp = (hp1 + hp2 + (hp1 + hp2 < 360 ? 360 : -360)) / 2;
  const T = 1 - 0.17 * Math.cos((hbp - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * hbp * Math.PI / 180)
    + 0.32 * Math.cos((3 * hbp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hbp - 63) * Math.PI / 180);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Rt = -Math.sin(2 * dTh * Math.PI / 180) * Rc;
  return Math.sqrt(
    (dLp / (kL * Sl)) ** 2 +
    (dCp / (kC * Sc)) ** 2 +
    (dHp / (kH * Sh)) ** 2 +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh))
  );
}

/* ---------- Small helpers ---------- */

export function hex(rgb255) {
  return '#' + rgb255.map(v => Math.max(0, Math.min(255, Math.round(v)))
    .toString(16).padStart(2, '0')).join('');
}

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }

export function stdev(a) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1));
}
