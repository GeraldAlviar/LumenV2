// In-memory, same-parent-frame transport for a restricted DOM-only test harness.
// No camera permission, network request or WebRTC operation is performed.
(() => {
  const registry = window.top.__lumenPeers ||= new Map();
  class Emitter {
    constructor() { this.handlers = new Map(); }
    on(t, f) { if (!this.handlers.has(t)) this.handlers.set(t, new Set()); this.handlers.get(t).add(f); return this; }
    off(t, f) { this.handlers.get(t)?.delete(f); }
    emit(t, d) { for (const f of [...(this.handlers.get(t) || [])]) f(d); }
  }
  class Connection extends Emitter {
    constructor() { super(); this.open = false; this.closed = false; }
    send(data) { if (!this.open) throw new Error('Test connection closed'); queueMicrotask(() => this.other.emit('data', structuredClone(data))); }
    close() { if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); this.other?.close(); }
  }
  class Peer extends Emitter {
    constructor(id) { super(); this.id = typeof id === 'string' ? id : Math.random().toString(36); registry.set(this.id, this); this.connections = []; queueMicrotask(() => this.emit('open', this.id)); }
    connect(id) {
      const a = new Connection(), b = new Connection(); a.other = b; b.other = a; this.connections.push(a);
      setTimeout(() => {
        const host = registry.get(id);
        if (!host) { this.emit('error', new Error('No test host')); return; }
        host.connections.push(b); host.emit('connection', b);
        if (b.closed) return;
        a.open = b.open = true; b.emit('open'); a.emit('open');
      }, 1);
      return a;
    }
    destroy() { registry.delete(this.id); for (const c of this.connections) c.close(); }
  }
  window.Peer = Peer;
})();
