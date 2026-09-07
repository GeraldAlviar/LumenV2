import { movementAmount } from './alignment.js?v=2.2.0';

// Hysteresis prevents slight hand tremor, one failed detection, or brief glare
// from restarting alignment. These are software heuristics, not measured pose.
export class VisualMotionGuard {
  constructor() { this.reset(); }
  reset(now = performance.now()) { this.lastSeen = now; this.movedAt = null; }
  check(locked, current, w, h, now = performance.now()) {
    if (!current) {
      this.movedAt = null;
      return now - this.lastSeen > 8000 ? 'lost' : 'searching';
    }
    this.lastSeen = now;
    const distance = movementAmount(locked, current, w, h);
    if (distance <= 0.12) { this.movedAt = null; return distance > 0.055 ? 'minor' : 'steady'; }
    this.movedAt ??= now;
    return now - this.movedAt >= (distance > 0.25 ? 500 : 1100) ? 'moved' : 'minor';
  }
}
