import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Link, normaliseRoomCode, makeRoomCode } from '../js/net.js';
class Conn extends EventEmitter {
  constructor() { super(); this.open = false; this.sent = []; this.closed = false; }
  send(value) { this.sent.push(value); }
  close() { if (this.closed) return; this.closed = true; this.open = false; this.emit('close'); }
  connect() { this.open = true; this.emit('open'); }
}
class Peer extends EventEmitter {
  constructor() { super(); queueMicrotask(() => this.emit('open', 'fake')); }
  connect() { this.conn = new Conn(); queueMicrotask(() => this.conn.connect()); return this.conn; }
  destroy() { this.destroyed = true; }
}
function connected(t) {
  const link = new Link({ PeerImpl: Peer, heartbeatMs: 0, timeoutMs: 50 });
  const conn = new Conn(); link._bind(conn); conn.connect(); t.after(() => link.destroy()); return { link, conn };
}
test('room codes have exact supported length and cryptographic generation', () => {
  assert.equal(normaliseRoomCode(' acdeg '), 'ACDEG');
  for (const value of ['ABCD', 'ABCDE', '12345', 'ACDEGG']) assert.throws(() => normaliseRoomCode(value));
  for (let i = 0; i < 20; i++) assert.equal(normaliseRoomCode(makeRoomCode()).length, 5);
});
test('missing PeerJS reports an actionable error', async () => {
  const link = new Link({ PeerImpl: null }); await assert.rejects(link.host('ACDEG'), /library did not load/);
});
test('broker initialisation has a real timeout', async () => {
  class SilentPeer extends EventEmitter { destroy() {} }
  const link = new Link({ PeerImpl: SilentPeer, timeoutMs: 15 });
  await assert.rejects(link.host('ACDEG'), /timed out/); assert.equal(link.peer, null);
});
test('host and join lifecycle completes', async t => {
  const host = new Link({ PeerImpl: Peer, heartbeatMs: 0 }); t.after(() => host.destroy());
  assert.equal(await host.host('ACDEG'), 'ACDEG'); assert.equal(host.state, 'waiting');
  const guest = new Link({ PeerImpl: Peer, heartbeatMs: 0 }); t.after(() => guest.destroy());
  await guest.join('ACDEG'); assert.equal(guest.state, 'open');
});
test('disconnected requests fail immediately without leaving waiters', async () => {
  const link = new Link(); await assert.rejects(link.request({ t: 'idle' }), /No display/); assert.equal(link._waiters.size, 0);
});
test('request acknowledgement resolves and cleans up', async t => {
  const { link, conn } = connected(t), promise = link.request({ t: 'idle' });
  const id = conn.sent.at(-1).__id; conn.emit('data', { t: 'rendered', at: 1, __reply: id });
  assert.equal((await promise).t, 'rendered'); assert.equal(link._waiters.size, 0);
});
test('remote rendering errors reject the pending request', async t => {
  const { link, conn } = connected(t), promise = link.request({ t: 'idle' });
  conn.emit('data', { t: 'error', error: 'Display hidden', __reply: conn.sent.at(-1).__id });
  await assert.rejects(promise, /Display hidden/);
});
test('connection loss promptly rejects all pending requests', async t => {
  const { link, conn } = connected(t), a = link.request({ t: 'idle' }), b = link.request({ t: 'idle' });
  const assertions = [assert.rejects(a, /disconnected/), assert.rejects(b, /disconnected/)]; conn.close();
  await Promise.all(assertions); assert.equal(link._waiters.size, 0);
});
test('cancelled requests clean up and ignore late acknowledgements', async t => {
  const { link, conn } = connected(t), controller = new AbortController(); let received = 0;
  link.addEventListener('message', () => received++);
  const p = link.request({ t: 'idle' }, 1000, { signal: controller.signal }), id = conn.sent.at(-1).__id;
  controller.abort(); await assert.rejects(p, { name: 'AbortError' });
  conn.emit('data', { t: 'rendered', at: 1, __reply: id }); assert.equal(received, 0); assert.equal(link._waiters.size, 0);
});
test('malformed JSON and invalid messages cannot crash or reach the UI', t => {
  const { link, conn } = connected(t); let received = 0;
  link.addEventListener('message', () => received++);
  for (const message of ['{', 'null', '[1,2]', { t: 'render', test: ['red'], anchor: 1 }, { t: 'made-up' }]) conn.emit('data', message);
  assert.equal(received, 0); conn.emit('data', { t: 'idle' }); assert.equal(received, 1);
});
test('a second phone cannot replace the active connection', t => {
  const { link, conn } = connected(t), second = new Conn();
  assert.equal(link._bind(second), false); assert.equal(link.conn, conn); assert.equal(second.closed, true);
});
test('old connection close events cannot break a newer connection', t => {
  const { link, conn } = connected(t); conn.close();
  const second = new Conn(); link._bind(second); second.connect(); conn.emit('close');
  assert.equal(link.conn, second); assert.equal(link.state, 'open');
});
test('request timeouts remove waiters', async t => {
  const { link } = connected(t); await assert.rejects(link.request({ t: 'idle' }, 15), /did not respond/);
  assert.equal(link._waiters.size, 0);
});
test('destroy cancels connection setup and releases peer resources', async () => {
  class SilentPeer extends EventEmitter { destroy() { this.destroyed = true; } }
  const link = new Link({ PeerImpl: SilentPeer }); const p = link.host('ACDEG'), peer = link.peer;
  link.destroy(); await assert.rejects(p, /cancelled/); assert.equal(peer.destroyed, true); assert.equal(link.peer, null);
});
