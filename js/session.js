// Portable raw data, separate from derived charts so analysis can be repeated.
import { validateResults, MAX_SESSION_BYTES, TARGET_IDS } from './validation.js';
export const SESSION_KEY = 'lumen:last-session:v1';

export function newSessionId(random = globalThis.crypto) {
  if (typeof random?.randomUUID === 'function') return random.randomUUID();
  // Compatibility fallback without weakening the randomness of identifiers.
  const bytes = random.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
}

export function createSession(data) {
  validateResults(data);
  return {
    format: 'lumen-session', version: 1, createdAt: new Date().toISOString(),
    target: data.target || 'gamma22', readings: data.readings || [],
    uniformity: data.uniformity || null, flicker: data.flicker || null,
    complete: data.complete ?? false, expected: data.expected ?? data.readings?.length ?? 0,
    sessionId: data.sessionId || '', synthetic: data.synthetic === true,
  };
}
export function parseSession(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_SESSION_BYTES)
    throw new Error('Session file exceeds the 2 MB limit.');
  let session;
  try { session = JSON.parse(text); } catch { throw new Error('This is not a valid JSON session file.'); }
  if (session?.format !== 'lumen-session' || session.version !== 1)
    throw new Error('Unsupported session format or version.');
  if (!TARGET_IDS.includes(session.target)) throw new Error('This session uses an unsupported target.');
  if (!Array.isArray(session.readings) || !Number.isFinite(Date.parse(session.createdAt)))
    throw new Error('This session is missing required data.');
  validateResults(session);
  const clean = createSession(session);
  clean.createdAt = session.createdAt;
  return clean;
}
export function sessionBlob(data) {
  return new Blob([JSON.stringify(createSession(data), null, 2)], { type: 'application/json' });
}
export function saveLastSession(data, storage) {
  try { (storage ?? globalThis.localStorage).setItem(SESSION_KEY, JSON.stringify(createSession(data))); return true; }
  catch { return false; } // Private mode and full storage must not lose the report.
}
