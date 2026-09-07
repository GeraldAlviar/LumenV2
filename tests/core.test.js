import test from 'node:test';
import assert from 'node:assert/strict';
import { srgbToLinear, linearToSrgb, deltaE2000, targetEotf } from '../js/colour.js';
import { ANCHORS, anchorFor, quickRun, fullRun, RUNS, TARGETS, greyscaleRun } from '../js/patches.js';
import { buildLadderScale, buildFlareMap, resolveReading, analyseGreyscale, buildCorrectionLut, isotonic, scorecard, tuningAdvice } from '../js/analysis.js';
import { buildIccProfile, buildArgyllCal, buildCsv, validateLut, csvCell } from '../js/icc.js';
import { syntheticReadings } from '../js/demo.js';
import { assessReadings } from '../js/quality.js';
import { validMessage, validateResults } from '../js/validation.js';
import { createSession, parseSession, saveLastSession, newSessionId } from '../js/session.js';
const readings = () => syntheticReadings(quickRun());
const identity = () => Object.fromEntries(['r', 'g', 'b'].map(c => [c, Float64Array.from({ length: 256 }, (_, i) => i / 255)]));

test('sRGB transfer functions round-trip', () => {
  for (let i = 0; i <= 255; i++) assert.ok(Math.abs(linearToSrgb(srgbToLinear(i / 255)) - i / 255) < 1e-12);
});
test('CIEDE2000 matches a standard reference pair', () => {
  assert.ok(Math.abs(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 0.0001);
});
test('dark patches use nearest higher reference', () => {
  assert.equal(anchorFor(0.1), 0.125); assert.equal(anchorFor(0.05), 0.0625);
  assert.equal(anchorFor(0.4), 0.5); assert.equal(anchorFor(0), 0.0625);
  assert.throws(() => anchorFor(NaN)); assert.throws(() => anchorFor(1.1));
});
test('every run includes its reference ladder and flare readings', () => {
  for (const run of Object.values(RUNS)) {
    const p = run.build();
    assert.equal(p.filter(x => x.kind === 'ladder').length, ANCHORS.length - 1);
    assert.ok(p.filter(x => x.kind === 'flare').length >= 2);
  }
});
test('greyscale sequence validates its step count', () => {
  assert.throws(() => greyscaleRun(1)); assert.throws(() => greyscaleRun(2.5)); assert.equal(greyscaleRun(11).length, 11);
});
test('reference ladder refuses missing readings instead of inventing a scale', () => {
  assert.throws(() => buildLadderScale(readings().filter(r => r.patch.level !== 0.25)), /reference/);
});
test('flare fit uses measured linear anchor brightness, not encoded signal', () => {
  const scale = new Map(ANCHORS.map(a => [a, [a ** 2.2, a ** 2.2, a ** 2.2]]));
  const floor = 0.002, slope = 0.015;
  const flares = ANCHORS.map(a => ({ patch: { kind: 'flare', anchor: a }, result: { ratio: [0, 1, 2].map(() => (floor + slope * a ** 2.2) / a ** 2.2) } }));
  const result = buildFlareMap(flares, scale);
  for (const s of result.slope) assert.ok(Math.abs(s - slope) < 1e-12);
  for (const v of resolveReading(flares[2], scale, result)) assert.ok(Math.abs(v - floor) < 1e-12);
});
test('greyscale analysis requires actual black and full white', () => {
  assert.throws(() => analyseGreyscale(readings().filter(r => !(r.patch.kind === 'grey' && r.patch.level === 1)), TARGETS.gamma22), /full-white/);
});
test('duplicate grey levels are rejected', () => {
  const rs = readings(); rs.push(rs.find(r => r.patch.kind === 'grey'));
  assert.throws(() => analyseGreyscale(rs, TARGETS.gamma22), /Duplicate/);
});
test('idealised synthetic camera exposure recovers approximate gamma', () => {
  const grey = analyseGreyscale(readings(), TARGETS.gamma22);
  assert.ok(Math.abs(grey.gamma - 2.35) < 0.07);
  assert.equal(grey.points[0].level, 0); assert.equal(grey.points.at(-1).level, 1);
});
test('insufficient midrange data does not fabricate target gamma', () => {
  const rs = readings().filter(r => r.patch.kind !== 'grey' || [0, 0.5, 1].includes(r.patch.level));
  const grey = analyseGreyscale(rs, TARGETS.gamma22); assert.equal(grey.gamma, null);
  assert.equal(scorecard(grey, null, null, null, TARGETS.gamma22)[0].status, 'estimate');
});
test('isotonic regression pools reversals in input order', () => {
  assert.deepEqual(isotonic([0, 0.3, 0.2, 1]), [0, 0.25, 0.25, 1]);
  assert.throws(() => isotonic([0, NaN, 1]));
});
test('correction LUT is bounded, monotonic, and endpoint-preserving', () => {
  const grey = analyseGreyscale(readings(), TARGETS.gamma22);
  grey.points[5].rgb = grey.points[4].rgb.map(v => v * 0.9);
  const lut = buildCorrectionLut(grey, TARGETS.gamma22); validateLut(lut);
  for (const values of Object.values(lut)) { assert.equal(values[0], 0); assert.equal(values.at(-1), 1); }
});
test('incomplete greyscale cannot produce a LUT', () => {
  assert.throws(() => buildCorrectionLut({ points: [] }, TARGETS.gamma22));
  assert.throws(() => buildCorrectionLut(analyseGreyscale(readings(), TARGETS.gamma22), TARGETS.gamma22, 1));
});
test('quality gate accepts complete valid readings', () => {
  assert.equal(assessReadings(readings()).canExport, true);
});
test('quality gate rejects clipping, missing readings, interruption and low reference', () => {
  const r = readings(); r[0].result.clipping = 0.03;
  assert.equal(assessReadings(r).canExport, false);
  assert.equal(assessReadings(readings(), { complete: false }).canExport, false);
  assert.equal(assessReadings(readings(), { expected: 999 }).canExport, false);
  const dark = readings(); dark[0].result.anchorLinear[0] = 0;
  assert.equal(assessReadings(dark).canExport, false);
});
test('contrast beyond camera floor is unresolved, not a certified lower bound', () => {
  const g = analyseGreyscale(readings(), TARGETS.gamma22); g.contrast = Infinity;
  const row = scorecard(g, null, null, null, TARGETS.gamma22).find(r => r.metric === 'Apparent contrast');
  assert.equal(row.value, 'Unresolved'); assert.equal(row.status, 'estimate');
});
test('gain advice directions match final step signs (legacy helper)', () => {
  for (const move of tuningAdvice([4, -1, -3]).moves) assert.equal(move.direction, move.steps < 0 ? 'down' : move.steps > 0 ? 'up' : 'hold');
});
test('ICC header, tag offsets, profile size and vcgt structure are valid', async () => {
  const bytes = await buildIccProfile({ lut: identity(), target: TARGETS.gamma22 }).arrayBuffer();
  const d = new DataView(bytes), text = (o, n = 4) => new TextDecoder().decode(new Uint8Array(bytes, o, n));
  assert.equal(d.getUint32(0), bytes.byteLength); assert.equal(text(36), 'acsp'); assert.equal(text(12), 'mntr');
  const count = d.getUint32(128); assert.equal(count, 10);
  let vcgt;
  for (let i = 0; i < count; i++) {
    const start = 132 + i * 12, offset = d.getUint32(start + 4), size = d.getUint32(start + 8);
    assert.equal(offset % 4, 0); assert.ok(offset + size <= bytes.byteLength);
    if (text(start) === 'vcgt') vcgt = offset;
  }
  assert.equal(d.getUint16(vcgt + 12), 3); assert.equal(d.getUint16(vcgt + 14), 256); assert.equal(d.getUint16(vcgt + 16), 2);
});
test('sRGB profile TRC stores the piecewise curve rather than gamma 2.2', async () => {
  const bytes = await buildIccProfile({ lut: identity(), target: TARGETS.srgb }).arrayBuffer(), d = new DataView(bytes);
  let offset;
  for (let i = 0; i < d.getUint32(128); i++) {
    const pos = 132 + i * 12;
    if (new TextDecoder().decode(new Uint8Array(bytes, pos, 4)) === 'rTRC') offset = d.getUint32(pos + 4);
  }
  assert.equal(d.getUint32(offset + 8), 1024);
  const index = 20, v = d.getUint16(offset + 12 + index * 2) / 65535;
  assert.ok(Math.abs(v - targetEotf(index / 1023, TARGETS.srgb)) < 1 / 65535);
});
test('exports reject unequal, nonfinite or nonmonotonic correction tables', () => {
  const lut = identity(); lut.b = new Float64Array(3); assert.throws(() => buildIccProfile({ lut }));
  const invalid = identity(); invalid.r[100] = NaN; assert.throws(() => buildArgyllCal(invalid));
  const reverse = identity(); reverse.g[120] = 0; assert.throws(() => validateLut(reverse));
});
test('Argyll calibration has the requested rows and endpoints', async () => {
  const text = await buildArgyllCal(identity(), 64).text();
  const rows = text.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0].split('\n');
  assert.equal(rows.length, 64); assert.equal(rows[0], '0.000000 0.000000 0.000000 0.000000');
  assert.equal(rows.at(-1), '1.000000 1.000000 1.000000 1.000000');
});
test('CSV escapes quotes, commas and newlines and blocks formula labels', async () => {
  assert.equal(csvCell('Hello, "screen"'), '"Hello, ""screen"""');
  assert.equal(csvCell('=1+1'), "'=1+1"); assert.equal(csvCell(-0.5), '-0.5');
  const r = readings(); r[0].patch.label = 'Grey, "test"\nsecond line';
  const text = await buildCsv(r, null).text(); assert.ok(text.includes('"Grey, ""test""\nsecond line"'));
});
test('session round trip preserves raw data and simulation labels', () => {
  const session = createSession({ readings: readings(), target: 'gamma22', complete: true, synthetic: true });
  assert.deepEqual(parseSession(JSON.stringify(session)), session);
});
test('session parser rejects malformed, oversized and unsupported data', () => {
  assert.throws(() => parseSession('{'));
  assert.throws(() => parseSession('x'.repeat(2 * 1024 * 1024 + 1)), /limit/);
  const session = createSession({ readings: readings() }); session.target = 'dcip3';
  assert.throws(() => parseSession(JSON.stringify(session)), /unsupported/);
});
test('storage failure is nonfatal', () => {
  assert.equal(saveLastSession({ readings: readings() }, { setItem() { throw new Error('Quota'); } }), false);
});
test('peer validation refuses nonfinite and malformed measurements', () => {
  const rs = readings(); rs[0].result.ratio[0] = Infinity;
  assert.throws(() => validateResults({ readings: rs }));
  assert.equal(validMessage({ t: 'render', test: [0, 0, 0], anchor: NaN }), false);
  assert.equal(validMessage({ t: 'progress', done: 1, total: 0, label: 'x' }), false);
  assert.equal(validMessage({ t: 'unknown' }), false);
  assert.equal(validMessage({ t: 'render', test: [0.5, 0.5, 0.5], anchor: 0.5 }), true);
});


test('session identifiers work with or without randomUUID', () => {
  assert.equal(newSessionId({ randomUUID: () => 'native-uuid' }), 'native-uuid');
  assert.equal(newSessionId({ getRandomValues: bytes => bytes.fill(171) }), 'ab'.repeat(16));
});
test('blocked localStorage getters do not discard a measurement', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Denied'); } });
  try { assert.equal(saveLastSession({ readings: readings(), target: 'srgb' }), false); }
  finally { if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor); else delete globalThis.localStorage; }
});
