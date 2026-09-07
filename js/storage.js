// IndexedDB holds recovery snapshots; localStorage holds preferences and a
// synchronous last snapshot as a fallback for pagehide/private-mode failures.
// These are device-local copies, not cookies and not a server account.
import { createSession, parseSession, saveLastSession, SESSION_KEY } from './session.js?v=2.1.0';

export class SessionStore {
  constructor(role = 'phone', host = globalThis) {
    this.role = role; this.host = host; this.db = null; this.queue = Promise.resolve();
    this.key = `${SESSION_KEY}:${role}`;
  }
  async open() {
    if (this.db) return this.db;
    if (!this.host.indexedDB) throw new Error('IndexedDB unavailable');
    return new Promise((resolve, reject) => {
      let done = false;
      const request = this.host.indexedDB.open('lumen-recovery-v2', 1);
      const timer = setTimeout(() => { done = true; reject(new Error('Storage open timed out')); }, 1200);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('sessions')) request.result.createObjectStore('sessions'); };
      request.onerror = () => { clearTimeout(timer); if (!done) reject(request.error); done = true; };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (done) { request.result.close(); return; }
        done = true; this.db = request.result;
        this.db.onversionchange = () => { this.db.close(); this.db = null; };
        resolve(this.db);
      };
    });
  }
  async transaction(mode, action) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sessions', mode); let value;
      const timer = setTimeout(() => { try { tx.abort(); } catch {} reject(new Error('Storage write timed out')); }, 1200);
      tx.oncomplete = () => { clearTimeout(timer); resolve(value); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error('Storage unavailable')); };
      const request = action(tx.objectStore('sessions'));
      if (request) request.onsuccess = () => { value = request.result; };
    });
  }
  saveSync(data) {
    try { const clean = createSession(data); this.host.localStorage.setItem(this.key, JSON.stringify(clean)); saveLastSession(clean, this.host.localStorage); return true; }
    catch { return false; }
  }
  save(data) {
    const clean = createSession(data), local = this.saveSync(clean);
    const task = async () => {
      try { await this.transaction('readwrite', s => s.put(clean, this.role)); return { saved: true, backend: 'IndexedDB' }; }
      catch { return { saved: local, backend: local ? 'localStorage fallback' : 'memory only' }; }
    };
    const result = this.queue.then(task, task); this.queue = result; return result;
  }
  async load() {
    // The synchronous copy may be newer if a page closed during an IDB write.
    try { const text = this.host.localStorage.getItem(this.key); if (text) return parseSession(text); } catch {}
    try { const value = await this.transaction('readonly', s => s.get(this.role)); return value ? parseSession(JSON.stringify(value)) : null; } catch { return null; }
  }
  async clear() {
    await this.queue.catch(() => {});
    let removed = false;
    try { this.host.localStorage.removeItem(this.key); this.host.localStorage.removeItem(SESSION_KEY); removed = true; } catch {}
    try { await this.transaction('readwrite', s => s.delete(this.role)); removed = true; } catch {}
    return removed;
  }
}
export function preference(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(`lumen:preference:${key}`);
    localStorage.setItem(`lumen:preference:${key}`, String(value));
  } catch {}
  return null;
}
