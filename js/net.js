// PeerJS signalling + one reliable, validated data channel per display.
import { abortError } from './async.js';
import { validMessage, MAX_SESSION_BYTES } from './validation.js';

const PREFIX = 'lumen-cal-';
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY3479';
export function normaliseRoomCode(value) {
  const code = String(value).trim().toUpperCase();
  if (code.length !== 5 || [...code].some(c => !ALPHABET.includes(c)))
    throw new Error('Enter the five-character code shown on your monitor.');
  return code;
}
export function makeRoomCode() {
  let code = '';
  const bytes = new Uint8Array(16);
  const ceiling = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (code.length < 5) {
    globalThis.crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b < ceiling) code += ALPHABET[b % ALPHABET.length];
      if (code.length === 5) break;
    }
  }
  return code;
}

export class Link extends EventTarget {
  constructor({ PeerImpl = globalThis.Peer, timeoutMs = 15000, heartbeatMs = 5000 } = {}) {
    super();
    this.PeerImpl = PeerImpl;
    this.timeoutMs = timeoutMs;
    this.heartbeatMs = heartbeatMs;
    this.conn = null;
    this.peer = null;
    this.state = 'idle';
    this._waiters = new Map();
    this._seq = 0;
    this._generation = 0;
    this._heartbeat = null;
    this._pendingReject = null;
  }
  _setState(state, detail = {}) {
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }
  _rejectWaiters(error) {
    for (const w of [...this._waiters.values()]) w.finish(error);
  }
  _drop(error = new Error('Device disconnected.')) {
    clearInterval(this._heartbeat);
    clearTimeout(this._connectTimer);
    this._rejectWaiters(error);
    const old = this.conn;
    this.conn = null;
    old?.close();
    this._setState('closed', { error: error.message });
  }
  destroy() {
    ++this._generation;
    const reject = this._pendingReject;
    this._pendingReject = null;
    reject?.(abortError('Connection cancelled.'));
    clearInterval(this._heartbeat);
    clearTimeout(this._connectTimer);
    this._rejectWaiters(new Error('Connection closed.'));
    const conn = this.conn, peer = this.peer;
    this.conn = this.peer = null;
    conn?.close();
    peer?.destroy();
    this._setState('idle');
  }
  async _openPeer(id) {
    this.destroy();
    if (typeof this.PeerImpl !== 'function')
      throw new Error('The pairing library did not load. Check your connection or content blocker, then reload.');
    const generation = this._generation;
    this._setState('connecting');
    const peer = id ? new this.PeerImpl(id, { debug: 1 }) : new this.PeerImpl({ debug: 1 });
    this.peer = peer;
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pendingReject = null;
        peer.off?.('open', onOpen);
        peer.off?.('error', onError);
        error ? reject(error) : resolve();
      };
      const onOpen = () => finish();
      const onError = error => finish(error);
      const timer = setTimeout(() => finish(new Error('Pairing service timed out. Check your connection and try again.')), this.timeoutMs);
      this._pendingReject = error => finish(error);
      peer.on('open', onOpen);
      peer.on('error', onError);
    }).catch(error => {
      if (generation === this._generation) { this.destroy(); this._setState('error', { error: error.message }); }
      throw error;
    });
    if (generation !== this._generation) throw abortError('Connection replaced.');
    peer.on('error', error => {
      if (this.peer !== peer) return;
      this._pendingReject?.(error);
      this._drop(error);
      this._setState('error', { error: error.message });
    });
    peer.on('disconnected', () => {
      if (this.peer !== peer) return;
      // An established WebRTC channel may still be usable without the broker.
      if (this.conn?.open) {
        this.dispatchEvent(new CustomEvent('notice', { detail: 'Pairing service disconnected; the current device link is still active.' }));
      } else this._drop(new Error('Pairing service disconnected. Please reconnect.'));
    });
    return peer;
  }
  _bind(conn) {
    if (this.conn && this.conn !== conn) {
      conn.on('open', () => conn.close());
      conn.close();
      return false;
    }
    this.conn = conn;
    this._lastSeen = Date.now();
    this._connectTimer = setTimeout(() => {
      if (this.conn === conn && !conn.open) this._drop(new Error('Device connection timed out.'));
    }, this.timeoutMs);
    conn.on('open', () => {
      if (this.conn !== conn) return;
      clearTimeout(this._connectTimer);
      this._lastSeen = Date.now();
      this._setState('open');
      clearInterval(this._heartbeat);
      if (this.heartbeatMs > 0) this._heartbeat = setInterval(() => {
        if (Date.now() - this._lastSeen > this.heartbeatMs * 4) {
          this._drop(new Error('Device stopped responding. Keep both pages open and reconnect.'));
        } else this.send({ t: 'ping' });
      }, this.heartbeatMs);
    });
    conn.on('close', () => { if (this.conn === conn) this._drop(); });
    conn.on('error', error => { if (this.conn === conn) this._drop(error); });
    conn.on('data', raw => {
      if (this.conn !== conn) return;
      let msg;
      try {
        if (typeof raw === 'string' && raw.length > MAX_SESSION_BYTES) return;
        msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!validMessage(msg)) return;
      } catch { return; }
      this._lastSeen = Date.now();
      if (msg.t === 'ping') { this.send({ t: 'pong' }); return; }
      if (msg.t === 'pong') return;
      if (msg.__reply) {
        const waiter = this._waiters.get(msg.__reply);
        if (waiter) waiter.finish(msg.t === 'error' ? new Error(msg.error) : null, msg);
        return; // Never deliver late acknowledgements as new commands.
      }
      this.dispatchEvent(new CustomEvent('message', { detail: msg }));
    });
    return true;
  }
  async host(value) {
    const code = normaliseRoomCode(value);
    const peer = await this._openPeer(PREFIX + code);
    peer.on('connection', conn => { if (this.peer === peer) this._bind(conn); else conn.close(); });
    this._setState('waiting');
    return code;
  }
  async join(value) {
    const code = normaliseRoomCode(value);
    const peer = await this._openPeer();
    const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
    this._bind(conn);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._pendingReject = null;
        this.removeEventListener('state', onState);
        conn.off?.('open', onOpen);
        error ? reject(error) : resolve();
      };
      const onOpen = () => finish();
      const onState = e => {
        if (['closed', 'error'].includes(e.detail.state)) finish(new Error(e.detail.error || 'Connection failed.'));
      };
      const timer = setTimeout(() => finish(new Error('No display answered. Check the code and keep both pages open.')), this.timeoutMs);
      this._pendingReject = error => finish(error);
      conn.on('open', onOpen);
      this.addEventListener('state', onState);
    }).catch(error => { if (this.peer === peer) this.destroy(); throw error; });
  }
  send(msg) {
    if (!this.conn?.open) return false;
    try { this.conn.send(msg); return true; }
    catch (error) { this._drop(error); return false; }
  }
  request(msg, timeout = 8000, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (!this.conn?.open) return Promise.reject(new Error('No display connected.'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      const finish = (error, response) => {
        if (!this._waiters.has(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this._waiters.delete(id);
        error ? reject(error) : resolve(response);
      };
      const cancel = () => finish(abortError(signal.reason));
      const timer = setTimeout(() => finish(new Error('Display did not respond. Keep its tab visible.')), timeout);
      this._waiters.set(id, { finish });
      signal?.addEventListener('abort', cancel, { once: true });
      if (!this.send({ ...msg, __id: id })) finish(new Error('Display disconnected.'));
    });
  }
  reply(to, msg) {
    if (Number.isSafeInteger(to.__id)) this.send({ ...msg, __reply: to.__id });
  }
}
export function createLink(options) { return new Link(options); }
