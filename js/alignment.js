// Small, dependency-free marker detector. It assists alignment; it is not a
// calibrated pose estimator. Four coloured corners stay OUTSIDE sample areas.
export const SAMPLE_POSITIONS = { anchor: [0.27, 0.5], test: [0.73, 0.5] };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export function polygonArea(q) {
  return Math.abs(q.reduce((s, p, i) => { const b = q[(i + 1) % q.length]; return s + p.x * b.y - p.y * b.x; }, 0)) / 2;
}
export function validQuad(q) {
  if (!Array.isArray(q) || q.length !== 4 || q.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 1 || p.y > 1)) return false;
  const crosses = q.map((p, i) => { const a = q[(i + 1) % 4], b = q[(i + 2) % 4]; return (a.x - p.x) * (b.y - a.y) - (a.y - p.y) * (b.x - a.x); });
  return crosses.every(n => n > 0) && polygonArea(q) > 0.004;
}
export function squareGuide(w, h, fraction = 0.72) {
  const side = Math.min(w, h) * fraction, x = (w - side) / 2 / w, y = (h - side) / 2 / h;
  return [{ x, y }, { x: 1 - x, y }, { x: 1 - x, y: 1 - y }, { x, y: 1 - y }];
}
// Homography from unit square to camera quadrilateral. Perspective is handled
// geometrically, but lens shading and display viewing angle are NOT corrected.
export function project(q, u, v) {
  const [a, b, c, d] = q;
  const dx1 = b.x - c.x, dx2 = d.x - c.x, sx = a.x - b.x + c.x - d.x;
  const dy1 = b.y - c.y, dy2 = d.y - c.y, sy = a.y - b.y + c.y - d.y;
  const det = dx1 * dy2 - dx2 * dy1;
  let g = 0, h = 0;
  if (Math.abs(sx) + Math.abs(sy) > 1e-10 && Math.abs(det) > 1e-10) {
    g = (sx * dy2 - dx2 * sy) / det; h = (dx1 * sy - sx * dy1) / det;
  }
  const z = g * u + h * v + 1;
  return { x: ((b.x - a.x + g * b.x) * u + (d.x - a.x + h * d.x) * v + a.x) / z,
    y: ((b.y - a.y + g * b.y) * u + (d.y - a.y + h * d.y) * v + a.y) / z };
}
export function sampleRegions(q, w, h) {
  if (!validQuad(q)) throw new Error('The sampling square is outside the camera image. Realign it.');
  const edge = Math.min(...q.map((p, i) => Math.hypot((p.x - q[(i + 1) % 4].x) * w, (p.y - q[(i + 1) % 4].y) * h)));
  const r = edge * 0.055 / Math.min(w, h);
  return Object.fromEntries(Object.entries(SAMPLE_POSITIONS).map(([key, [u, v]]) => [key, { ...project(q, u, v), r, shape: 'square' }]));
}
function components(data, w, h, isColour) {
  const mask = new Uint8Array(w * h), seen = new Uint8Array(w * h), stack = new Int32Array(w * h), found = [];
  for (let i = 0; i < mask.length; i++) mask[i] = isColour(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]) ? 1 : 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || seen[i]) continue;
    let n = 0, sx = 0, sy = 0, sp = 1, minX = w, minY = h, maxX = 0, maxY = 0;
    stack[0] = i; seen[i] = 1;
    while (sp) {
      const p = stack[--sp], x = p % w, y = Math.floor(p / w); n++; sx += x; sy += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const j of [x > 0 ? p - 1 : -1, x + 1 < w ? p + 1 : -1, y > 0 ? p - w : -1, y + 1 < h ? p + w : -1])
        if (j >= 0 && mask[j] && !seen[j]) { seen[j] = 1; stack[sp++] = j; }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    if (n >= 6 && n < w * h * 0.025 && bw / bh > 0.35 && bw / bh < 2.8 && n / (bw * bh) > 0.4)
      found.push({ x: sx / n / w, y: sy / n / h, n });
  }
  return found.sort((a, b) => b.n - a.n).slice(0, 10);
}
export function detectSquare(image, { rectangular = false } = {}) {
  const { data, width: w, height: h } = image;
  const magenta = components(data, w, h, (r, g, b) => r > 70 && b > 65 && Math.min(r, b) > g * 1.3 + 12);
  const cyan = components(data, w, h, (r, g, b) => g > 65 && b > 65 && Math.min(g, b) > r * 1.3 + 12);
  let best = null, score = 0;
  for (const tl of magenta.slice(0, 5)) for (const tr of cyan) for (const br of cyan) for (const bl of cyan) {
    if (tr === br || tr === bl || br === bl || tr.x <= tl.x || bl.y <= tl.y) continue;
    const q = [tl, tr, br, bl];
    if (!validQuad(q)) continue;
    const pixels = q.map(p => ({ x: p.x * w, y: p.y * h }));
    const sides = pixels.map((p, i) => distance(p, pixels[(i + 1) % 4]));
    const ratio = (sides[0] + sides[2]) / (sides[1] + sides[3]);
    if (ratio < (rectangular ? 0.35 : 0.55) || ratio > (rectangular ? 3.2 : 1.8) ||
        Math.max(sides[0] / sides[2], sides[2] / sides[0], sides[1] / sides[3], sides[3] / sides[1]) > 1.7 ||
        Math.max(...q.map(p => p.n)) / Math.min(...q.map(p => p.n)) > 5) continue;
    const s = polygonArea(q) * Math.min(...q.map(p => p.n));
    if (s > score) { score = s; best = q.map(({ x, y }) => ({ x, y })); }
  }
  return best;
}
export function alignmentAdvice(q, guide, w, h) {
  if (!q) return { grade: 'Manual', message: 'Match the four corners to the guide. Lock is still available if automatic detection cannot see them.' };
  const error = Math.max(...q.map((p, i) => Math.hypot((p.x - guide[i].x) * w, (p.y - guide[i].y) * h))) / Math.min(w, h);
  if (error < 0.045) return { grade: 'Excellent', message: 'Squares match. Rest the phone, then lock sampling.' };
  if (error < 0.10) return { grade: 'Good', message: 'Good alignment. You can lock now; a perfect match is not required.' };
  const scale = Math.sqrt(polygonArea(q) / polygonArea(guide));
  const dx = q.reduce((s, p) => s + p.x, 0) / 4 - 0.5;
  const dy = q.reduce((s, p) => s + p.y, 0) / 4 - 0.5;
  let message = scale < 0.82 ? 'Move the phone closer until the squares match.' : scale > 1.18 ? 'Move the phone farther back until the squares match.'
    : Math.abs(dx) > 0.07 || Math.abs(dy) > 0.07 ? 'Centre the monitor square inside the phone guide.' : 'Face the monitor square-on and straighten the phone.';
  return { grade: 'Fair', message: message + ' Lock remains available.' };
}
export function movementAmount(a, b, w, h) {
  if (!validQuad(a) || !validQuad(b)) return Infinity;
  const scale = Math.sqrt(polygonArea(a) * w * h);
  return Math.max(...a.map((p, i) => Math.hypot((p.x - b[i].x) * w, (p.y - b[i].y) * h))) / Math.max(1, scale);
}
