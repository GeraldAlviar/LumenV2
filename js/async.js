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

// A deadline also aborts the underlying task. A late browser/API resolution is
// ignored, so a missing frame or acknowledgement can never strand the UI.
export function withDeadline(work, ms, label, signal) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error && !controller.signal.aborted) controller.abort(error);
      error ? reject(error) : resolve(value);
    };
    const cancel = () => finish(abortError(signal.reason));
    const timer = setTimeout(() => finish(new Error(label || 'Operation timed out.')), ms);
    if (signal?.aborted) return cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { throwIfAborted(controller.signal); return work(controller.signal); })
      .then(value => finish(null, value), error => finish(error));
  });
}
