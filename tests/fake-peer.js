// Browser test transport only: substitutes the external signalling/WebRTC layer.
// Production pages never load this file. It does not test real network traversal.
(() => {
  class Emitter {
    constructor() { this.handlers = new Map(); }
    on(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, new Set()); this.handlers.get(type).add(fn); return this; }
    off(type, fn) { this.handlers.get(type)?.delete(fn); return this; }
    emit(type, value) { for (const fn of [...(this.handlers.get(type) || [])]) fn(value); }
  }
  class Connection extends Emitter {
    constructor(peer, remote, id) { super(); this.owner = peer; this.peer = remote; this.id = id; this.open = false; this.closed = false; }
    send(data) { if (!this.open) throw new Error('Closed test connection'); this.owner.post({ type: 'data', target: this.peer, connection: this.id, data }); }
    close() {
      if (this.closed) return; this.closed = true; this.open = false;
      if (!this.owner.destroyed) this.owner.post({ type: 'close', target: this.peer, connection: this.id });
      this.emit('close');
    }
  }
  class Peer extends Emitter {
    constructor(id) {
      super(); this.id = typeof id === 'string' ? id : crypto.randomUUID(); this.connections = new Map();
      this.channel = new BroadcastChannel('lumen-browser-regression');
      this.channel.onmessage = event => {
        const m = event.data; if (m.target !== this.id) return;
        if (m.type === 'connect') {
          const c = new Connection(this, m.source, m.connection); this.connections.set(c.id, c);
          this.emit('connection', c);
          queueMicrotask(() => { if (c.closed) return; c.open = true; c.emit('open'); this.post({ type: 'ack', target: m.source, connection: c.id }); });
        } else {
          const c = this.connections.get(m.connection); if (!c) return;
          if (m.type === 'ack') { c.open = true; c.emit('open'); }
          if (m.type === 'data') c.emit('data', m.data);
          if (m.type === 'close') { c.closed = true; c.open = false; c.emit('close'); }
        }
      };
      queueMicrotask(() => this.emit('open', this.id));
    }
    post(value) { this.channel.postMessage({ ...value, source: this.id }); }
    connect(remote) {
      const c = new Connection(this, remote, crypto.randomUUID()); this.connections.set(c.id, c);
      this.post({ type: 'connect', target: remote, connection: c.id }); return c;
    }
    destroy() { if (this.destroyed) return; for (const c of this.connections.values()) c.close(); this.destroyed = true; this.channel.close(); }
  }
  window.Peer = Peer;
})();
