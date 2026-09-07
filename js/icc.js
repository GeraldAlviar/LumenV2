// Experimental correction export. Matrix primaries are assumed sRGB, not
// measured monitor primaries. The UI requires explicit acknowledgement.
import { targetEotf } from './colour.js';

export function validateLut(lut) {
  const length = lut?.r?.length;
  if (!Number.isInteger(length) || length < 2 || length > 65535) throw new Error('Invalid correction table.');
  for (const ch of ['r', 'g', 'b']) {
    const values = lut[ch];
    if (!values || values.length !== length) throw new Error('All correction channels must have the same length.');
    for (let i = 0; i < length; i++) {
      if (!Number.isFinite(values[i]) || values[i] < 0 || values[i] > 1 || (i && values[i] < values[i - 1]))
        throw new Error('Correction curves must be finite, bounded and monotonic.');
    }
  }
}
function resample(values, index, count) {
  const position = index * (values.length - 1) / (count - 1);
  const lo = Math.floor(position), hi = Math.min(values.length - 1, lo + 1);
  return values[lo] + (values[hi] - values[lo]) * (position - lo);
}
function checkEntries(entries) {
  if (!Number.isInteger(entries) || entries < 2 || entries > 65535) throw new Error('Invalid export table size.');
}

const s15 = v => Math.round(v * 65536);

class Writer {
  constructor() { this.parts = []; this.length = 0; }
  push(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.parts.push(u); this.length += u.length; return this;
  }
  pad4() {
    const r = this.length % 4;
    if (r) this.push(new Uint8Array(4 - r));
    return this;
  }
  bytes() {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

function sig(s) { return new Uint8Array([...s].map(c => c.charCodeAt(0))); }

function u32(v) {
  const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); return b;
}
function i32(v) {
  const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); return b;
}
function u16(v) {
  const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, false); return b;
}

/* ---------- Tag builders ---------- */

function xyzTag(x, y, z) {
  const w = new Writer();
  w.push(sig('XYZ ')).push(u32(0));
  w.push(i32(s15(x))).push(i32(s15(y))).push(i32(s15(z)));
  return w.bytes();
}

function curveTag(values) {
  const w = new Writer();
  w.push(sig('curv')).push(u32(0)).push(u32(values.length));
  for (const v of values) w.push(u16(Math.max(0, Math.min(65535, Math.round(v * 65535)))));
  return w.bytes();
}

function gammaCurveTag(gamma) {
  const w = new Writer();
  w.push(sig('curv')).push(u32(0)).push(u32(1));
  w.push(u16(Math.round(gamma * 256)));
  return w.bytes();
}

// textDescriptionType. The ASCII block is what applications actually read, but
// the Unicode and ScriptCode padding must be present or strict parsers reject
// the profile.
function descTag(text) {
  const ascii = String(text).replace(/[^\x20-\x7e]/g, '?').slice(0, 66) + '\0';
  const w = new Writer();
  w.push(sig('desc')).push(u32(0)).push(u32(ascii.length));
  w.push(sig(ascii));
  w.push(u32(0)).push(u32(0));      // Unicode language code and count
  w.push(u16(0)).push(new Uint8Array([0])); // ScriptCode code and count
  w.push(new Uint8Array(67));        // ScriptCode body
  return w.bytes();
}

function textTag(text) {
  const w = new Writer();
  w.push(sig('text')).push(u32(0)).push(sig(text + '\0'));
  return w.bytes();
}

// vcgt, Apple's video card gamma tag. Table form: three channels of 16-bit
// entries. This is the payload the graphics driver loads at login.
function vcgtTag(lut, entries = 256) {
  const w = new Writer();
  w.push(sig('vcgt')).push(u32(0)).push(u32(0)); // 0 = table format
  w.push(u16(3)).push(u16(entries)).push(u16(2));
  for (const ch of ['r', 'g', 'b']) {
    for (let i = 0; i < entries; i++) {
      const src = lut[ch];
      w.push(u16(Math.round(resample(src, i, entries) * 65535)));
    }
  }
  return w.bytes();
}

/* ---------- Profile assembly ---------- */

// sRGB primaries chromatically adapted to D50, which is the PCS white point ICC
// requires. These describe assumed sRGB primaries, not measured primaries, and should be replaced by measured primaries only when
// the camera has been referenced against a known source.
const PRIMARIES_D50 = {
  r: [0.43607, 0.22249, 0.01392],
  g: [0.38515, 0.71687, 0.09708],
  b: [0.14307, 0.06061, 0.71410],
  white: [0.96420, 1.00000, 0.82491],
};

export function buildIccProfile({ description = 'Lumen experimental correction', lut, gamma = 2.2, target, copyright = 'Experimental camera-based correction. Assumed sRGB primaries.' }) {
  validateLut(lut);
  target = target || { eotf: 'power', gamma };
  if (!['srgb', 'power', 'bt1886'].includes(target.eotf) || !Number.isFinite(target.gamma) || target.gamma <= 0 || target.gamma > 10)
    throw new Error('Invalid transfer curve target.');
  const trc = target.eotf === 'srgb'
    ? curveTag(Array.from({ length: 1024 }, (_, i) => targetEotf(i / 1023, target)))
    : gammaCurveTag(target.gamma);
  const tags = [
    ['desc', descTag(description)],
    ['wtpt', xyzTag(...PRIMARIES_D50.white)],
    ['rXYZ', xyzTag(...PRIMARIES_D50.r)],
    ['gXYZ', xyzTag(...PRIMARIES_D50.g)],
    ['bXYZ', xyzTag(...PRIMARIES_D50.b)],
    ['rTRC', trc],
    ['gTRC', trc],
    ['bTRC', trc],
    ['vcgt', vcgtTag(lut)],
    ['cprt', textTag(copyright)],
  ];

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  let offset = headerSize + tableSize;
  const placed = tags.map(([name, data]) => {
    const pad = (4 - (data.length % 4)) % 4;
    const entry = { name, data, offset, size: data.length, pad };
    offset += data.length + pad;
    return entry;
  });
  const total = offset;

  const w = new Writer();
  // Header
  w.push(u32(total));
  w.push(sig('LUMN'));                 // preferred CMM
  w.push(u32(0x02400000));             // version 2.4
  w.push(sig('mntr'));                 // device class: display
  w.push(sig('RGB '));
  w.push(sig('XYZ '));
  const d = new Date();
  [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
   d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()].forEach(v => w.push(u16(v)));
  w.push(sig('acsp'));
  w.push(u32(0));                      // platform: none
  w.push(u32(0));                      // flags
  w.push(u32(0));                      // manufacturer
  w.push(u32(0));                      // model
  w.push(u32(0)).push(u32(0));         // attributes
  w.push(u32(0));                      // rendering intent: perceptual
  w.push(i32(s15(0.96420))).push(i32(s15(1.0))).push(i32(s15(0.82491)));
  w.push(sig('LUMN'));                 // creator
  w.push(new Uint8Array(44));          // reserved

  // Tag table
  w.push(u32(placed.length));
  placed.forEach(t => {
    w.push(sig(t.name)).push(u32(t.offset)).push(u32(t.size));
  });
  // Tag data
  placed.forEach(t => {
    w.push(t.data);
    if (t.pad) w.push(new Uint8Array(t.pad));
  });

  return new Blob([w.bytes()], { type: 'application/vnd.iccprofile' });
}

/* ---------- Other export formats ---------- */

// ArgyllCMS .cal, so DisplayCAL or dispwin can load the same curves, and so the
// measurements are not locked inside this tool.
export function buildArgyllCal(lut, entries = 256) {
  validateLut(lut); checkEntries(entries);
  const lines = [
    'CAL', '',
    'DESCRIPTOR "Display calibration measured with Lumen"',
    'ORIGINATOR "Lumen"',
    `CREATED "${new Date().toUTCString()}"`,
    'DEVICE_CLASS "DISPLAY"',
    'COLOR_REP "RGB"', '',
    'NUMBER_OF_FIELDS 4',
    'BEGIN_DATA_FORMAT',
    'RGB_I RGB_R RGB_G RGB_B',
    'END_DATA_FORMAT', '',
    `NUMBER_OF_SETS ${entries}`,
    'BEGIN_DATA',
  ];
  for (let i = 0; i < entries; i++) {
    const t = i / (entries - 1);
    lines.push([t, ...['r', 'g', 'b'].map(ch => resample(lut[ch], i, entries))]
      .map(v => v.toFixed(6)).join(' '));
  }
  lines.push('END_DATA', '');
  return new Blob([lines.join('\n')], { type: 'text/plain' });
}

// Quote commas, quotes and newlines, and neutralise spreadsheet formula text.
export function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
export function buildCsv(readings, greyscale) {
  const rows = [[
    'kind', 'label', 'signal_level', 'anchor', 'ratio_r', 'ratio_g', 'ratio_b',
    'stability', 'clipping', 'noise', 'samples', 'converged',
  ].join(',')];
  readings.forEach(r => {
    rows.push([
      r.patch.kind, r.patch.label,
      r.patch.level ?? '', r.patch.anchor ?? '',
      ...r.result.ratio.map(v => v.toFixed(6)),
      r.result.stability.toFixed(5),
      r.result.clipping.toFixed(4),
      r.result.noise.toFixed(4),
      r.result.samples,
      r.result.converged,
    ].map(csvCell).join(','));
  });
  if (greyscale) {
    rows.push('', ['signal', 'measured_Y', 'target_Y', 'error_pct',
      'balance_r_pct', 'balance_g_pct', 'balance_b_pct', 'effective_gamma'].join(','));
    greyscale.points.forEach(p => {
      rows.push([
        p.level.toFixed(4), p.measured.toFixed(6), p.target.toFixed(6),
        p.errorPct.toFixed(3), ...p.balance.map(v => v.toFixed(2)),
        p.effGamma ? p.effGamma.toFixed(3) : '',
      ].join(','));
    });
  }
  return new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8' });
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
