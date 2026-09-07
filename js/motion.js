// Optional iPhone sensor assistance, supplemented by visual marker tracking.
// Permission denial does not block testing; neither method guarantees motion
// detection. Deliberate re-alignment is required after a pause.
export class MotionGuard extends EventTarget {
  constructor(host = globalThis.window) {
    super(); this.host = host; this.enabled = false; this.armed = false; this.hits = 0;
    this.handler = event => {
      if (!this.enabled || !this.armed) return;
      const r = event.rotationRate || {}, a = event.acceleration || {};
      const rotation = Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
      const acceleration = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
      this.hits = rotation > 12 || acceleration > 1.4 ? this.hits + 1 : 0;
      if (this.hits >= 3) { this.armed = false; this.dispatchEvent(new Event('movement')); }
    };
  }
  async enable() {
    const api = this.host?.DeviceMotionEvent;
    if (!api) return false;
    // Must be called directly from a user gesture on iOS.
    if (typeof api.requestPermission === 'function' && await api.requestPermission() !== 'granted') return false;
    this.host.removeEventListener('devicemotion', this.handler);
    this.host.addEventListener('devicemotion', this.handler); this.enabled = true; return true;
  }
  arm() { this.hits = 0; this.armed = true; }
  disarm() { this.armed = false; this.hits = 0; }
  destroy() { this.disarm(); this.host?.removeEventListener('devicemotion', this.handler); }
}
