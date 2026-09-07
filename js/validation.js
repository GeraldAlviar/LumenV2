// Validate untrusted peer messages and imported files before analysis or rendering.
export const MAX_READINGS = 512;
export const MAX_SESSION_BYTES = 2 * 1024 * 1024;
export const TARGET_IDS = ['srgb', 'gamma22', 'rec709'];
const kinds = new Set(['grey', 'ladder', 'flare', 'gamut', 'memory']);
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const finite = (v, min = -Infinity, max = Infinity) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
export const triple = (v, min = 0, max = 1e6) =>
  Array.isArray(v) && v.length === 3 && v.every(n => finite(n, min, max));
const text = (v, max = 200) => typeof v === 'string' && v.length <= max;

export function validReading(r) {
  if (!record(r) || !record(r.patch) || !record(r.result)) return false;
  const p = r.patch, m = r.result;
  return kinds.has(p.kind) && text(p.label) && triple(p.test, 0, 1) &&
    finite(p.anchor, 0.0001, 1) && (p.level === undefined || finite(p.level, 0, 1)) &&
    (!['grey', 'ladder', 'flare'].includes(p.kind) || finite(p.level, 0, 1)) &&
    triple(m.ratio) && finite(m.lumaRatio, 0, 1e6) &&
    finite(m.stability, 0, 1e6) && finite(m.clipping, 0, 1) && finite(m.noise, 0, 1e6) &&
    Number.isInteger(m.samples) && m.samples >= 1 && m.samples <= 100000 &&
    typeof m.converged === 'boolean' && triple(m.anchorLinear, 0, 1) && triple(m.testLinear, 0, 1);
}

export function validUniformity(u) {
  return record(u) && Number.isInteger(u.rows) && Number.isInteger(u.cols) &&
    u.rows >= 1 && u.rows <= 9 && u.cols >= 1 && u.cols <= 9 &&
    finite(u.worstDeviation, 0, 1e6) && finite(u.spread, 0, 100) &&
    Array.isArray(u.cells) && u.cells.length === u.rows * u.cols &&
    u.cells.every((c, i) => record(c) && c.row === Math.floor(i / u.cols) && c.col === i % u.cols &&
      finite(c.relative, 0, 1e6) && finite(c.deviation, -100, 1e6) && finite(c.luma, 0, 1));
}

export function validFlicker(f) {
  return record(f) && Number.isInteger(f.samples) && f.samples >= 3 &&
    finite(f.sampleHz, 0.1, 1000) && finite(f.modulationDepth, 0, 2) &&
    finite(f.rms, 0, 1e6) && text(f.verdict);
}

export function validateResults(m) {
  if (!record(m)) throw new Error('Invalid results object.');
  if (m.target !== undefined && !TARGET_IDS.includes(m.target)) throw new Error('Unsupported target.');
  if (m.readings !== undefined && (!Array.isArray(m.readings) || m.readings.length > MAX_READINGS ||
      !m.readings.every(validReading))) throw new Error('Invalid or oversized measurement data.');
  if (m.uniformity != null && !validUniformity(m.uniformity)) throw new Error('Invalid uniformity data.');
  if (m.flicker != null && !validFlicker(m.flicker)) throw new Error('Invalid modulation data.');
  if (m.expected !== undefined && (!Number.isInteger(m.expected) || m.expected < 0 || m.expected > MAX_READINGS))
    throw new Error('Invalid expected reading count.');
  if (m.synthetic !== undefined && typeof m.synthetic !== 'boolean') throw new Error('Invalid simulation flag.');
  if (m.complete !== undefined && typeof m.complete !== 'boolean') throw new Error('Invalid completion flag.');
  if (m.sessionId !== undefined && !text(m.sessionId, 100)) throw new Error('Invalid session identifier.');
  return m;
}

export function validMessage(m) {
  if (!record(m) || !text(m.t, 30)) return false;
  if (m.__id !== undefined && (!Number.isSafeInteger(m.__id) || m.__id < 1)) return false;
  if (m.__reply !== undefined && (!Number.isSafeInteger(m.__reply) || m.__reply < 1)) return false;
  switch (m.t) {
    case 'render': return triple(m.test, 0, 1) && text(m.label ?? '') &&
      (m.layout === 'field' || (m.layout === undefined && finite(m.anchor, 0, 1)));
    case 'rendered': return finite(m.at, 0);
    case 'error': return text(m.error);
    case 'target': return TARGET_IDS.includes(m.target);
    case 'progress': return Number.isInteger(m.done) && Number.isInteger(m.total) &&
      m.total > 0 && m.total <= MAX_READINGS && m.done >= 0 && m.done <= m.total && text(m.label);
    case 'live': return triple(m.balance, -1e4, 1e4) && finite(m.stability, 0);
    case 'results': try { validateResults(m); return true; } catch { return false; }
    case 'run-start': return text(m.sessionId, 100) && TARGET_IDS.includes(m.target) &&
      Number.isInteger(m.expected) && m.expected > 0 && m.expected <= MAX_READINGS;
    case 'interrupt': return text(m.reason);
    case 'hello': case 'idle': case 'reset': case 'ping': case 'pong': return true;
    default: return false;
  }
}
