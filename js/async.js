// Shared cancellation primitives. Every listener and timer has one owner.
export function abortError(reason = 'Operation cancelled') {
  return reason instanceof Error ? reason : new DOMException(String(reason), 'AbortError');
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal.reason);
}

export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal.reason));
    const done = () => { cleanup(); resolve(); };
    const cancel = () => { cleanup(); reject(abortError(signal.reason)); };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}
