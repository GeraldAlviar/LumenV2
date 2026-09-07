// One owner for measurement lifecycle, retries and checkpoints. Browser/UI,
// network and camera operations are injected so the real failure paths can be
// regression-tested, not just a happy-path simulation.
import { withDeadline, delay, throwIfAborted, abortError } from './async.js?v=2.1.0';
import { MODES, verifyResume } from './modes.js?v=2.1.0';
import { readingIssues } from './quality.js?v=2.1.0';
import { newSessionId, createSession } from './session.js?v=2.1.0';
import { STAGES, MAX_RETRIES } from './config.js?v=2.1.0';

export class TestRunner extends EventTarget {
  constructor(io, { retries = MAX_RETRIES, deadlines = {} } = {}) {
    super(); this.io = io; this.retries = retries;
    this.deadlines = { begin: 6500, preflight: 30000, render: 6000, measureExtra: 1000, checkpoint: 6500, diagnostics: 30000, retry: 300, ...deadlines }; this.session = null;
    this.controller = null; this.phase = 'idle'; this.revision = 0;
    this.liveLabel = ''; this.clock = 0; this.segmentAt = 0; this.patchTimes = [];
  }
  get busy() { return Boolean(this.controller); }
  restore(data) {
    if (this.busy) throw new Error('Pause the active test before restoring another one.');
    verifyResume(data); this.session = createSession(data); this.session.phase = 'paused'; this.phase = 'paused';
    this.clock = this.session.elapsedMs || 0; this.emit('paused', 'Recovered progress. Realign and recheck exposure before resuming.');
  }
  elapsed() { return this.clock + (this.segmentAt ? performance.now() - this.segmentAt : 0); }
  remaining() {
    if (!this.session) return 0;
    const mode = MODES[this.session.run], n = this.session.expected - this.session.readings.length;
    const per = this.patchTimes.length ? this.patchTimes.reduce((a, b) => a + b, 0) / this.patchTimes.length / 1000 : (mode.seconds[0] + mode.seconds[1]) / 2 / this.session.expected;
    return Math.max(0, n * per + (mode.uniformity && !this.session.uniformity && !this.session.omissions.uniformity ? 8 : 0) + (mode.temporal && !this.session.flicker && !this.session.omissions.temporal ? 6 : 0));
  }
  emit(phase = this.phase, label = this.liveLabel) {
    if (!this.session) return;
    this.phase = phase; this.liveLabel = String(label).slice(0, 500); this.session.phase = phase;
    this.session.elapsedMs = this.elapsed();
    const status = { t: 'run-state', sessionId: this.session.sessionId, phase, label: this.liveLabel,
      done: this.session.readings.length, total: this.session.expected, remaining: phase === 'complete' ? 0 : this.remaining(), elapsedMs: this.session.elapsedMs, revision: ++this.revision };
    this.io.notify?.(status);
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
  pause(reason = 'Paused. Realign and recheck the camera before resuming.', metric) {
    if (metric && this.session) this.session.telemetry[metric] = (this.session.telemetry[metric] || 0) + 1;
    if (this.controller) { this.stopPhase = 'paused'; this.controller.abort(abortError(reason)); }
  }
  stop(reason = 'Stopped. Completed readings are saved.') {
    if (this.controller) { this.stopPhase = 'stopped'; this.controller.abort(abortError(reason)); }
    else if (this.session) { this.session.reason = reason; this.emit('stopped', reason); this.io.save?.(this.session); }
  }
  async start({ run = 'standard', target = 'gamma22', resume = false } = {}) {
    if (this.busy) return false;
    const controller = new AbortController(); this.controller = controller; this.stopPhase = 'paused';
    const signal = controller.signal;
    let timer;
    try {
      if (resume) verifyResume(this.session);
      else {
        const mode = MODES[run]; if (!mode) throw new Error('Unknown test mode.');
        this.clock = 0; this.patchTimes = [];
        this.session = createSession({ run, target, planVersion: 1, sessionId: newSessionId(), expected: mode.build().length,
          readings: [], complete: false, phase: 'preflight', telemetry: {}, omissions: {} });
      }
      const session = this.session, mode = MODES[session.run], plan = mode.build();
      session.reason = ''; session.complete = false;
      this.segmentAt = performance.now();
      this.emit('starting', 'Checking that both devices are ready...');
      timer = setInterval(() => this.emit(), 1000);
      await withDeadline(s => this.io.begin(session, s), this.deadlines.begin, 'Monitor did not acknowledge the test. Reconnect both pages.', signal);
      this.emit('preflight', resume ? 'Rechecking alignment and the saved reference before resuming...' : 'Checking exposure, clipping and fresh camera frames...');
      const baseline = await withDeadline(s => this.io.preflight(session, s, resume), this.deadlines.preflight, 'Camera setup timed out. Retry camera setup.', signal);
      throwIfAborted(signal);
      if (!session.baseline) session.baseline = baseline;
      if (resume) session.telemetry.resumes = (session.telemetry.resumes || 0) + 1;
      await this.io.save(session);
      for (let index = session.readings.length; index < plan.length; index++) {
        const patch = plan[index]; let reading;
        const started = performance.now();
        for (let attempt = 0; attempt <= this.retries; attempt++) {
          throwIfAborted(signal);
          try {
            this.emit('rendering', `${index + 1}/${plan.length}: ${patch.label}`);
            await withDeadline(s => this.io.render(patch, s), this.deadlines.render, 'Monitor did not confirm the displayed patch.', signal);
            this.emit('settling', `${patch.label} - keep the phone still`);
            await delay(mode.sample.settleMs, signal);
            this.emit('sampling', `${patch.label} - collecting camera frames`);
            const result = await withDeadline(s => this.io.measure({ ...mode.sample, settleMs: 0, signal: s }), mode.sample.maxMs + this.deadlines.measureExtra,
              'Camera stopped supplying frames. Keep Safari and the preview visible.', signal);
            throwIfAborted(signal);
            this.emit('checking', `Validating ${patch.label}`);
            reading = { patch, result };
            const issues = readingIssues(reading);
            session.telemetry.maxDrift = Math.max(session.telemetry.maxDrift || 0, result.exposureDrift || 0);
            if (issues.length) {
              if (result.clipping > 0.02) session.telemetry.clipping = (session.telemetry.clipping || 0) + 1;
              throw new Error(`${patch.label}: ${issues.join(', ')}. Realign or retry camera setup.`);
            }
            break;
          } catch (error) {
            throwIfAborted(signal);
            if (attempt >= this.retries) throw error;
            session.telemetry.retries = (session.telemetry.retries || 0) + 1;
            this.emit('retrying', `Retry ${attempt + 1}/${this.retries}: ${error.message}`);
            await delay(this.deadlines.retry, signal);
          }
        }
        throwIfAborted(signal);
        // Save locally BEFORE requiring the display's acknowledgement. A lost
        // acknowledgement cannot lose or duplicate a valid camera reading.
        session.readings.push(reading);
        this.emit('saving', `Received ${index + 1}/${plan.length}. Saving on both devices...`);
        const local = await this.io.save(session);
        if (local?.saved === false) session.telemetry.storageFailures = (session.telemetry.storageFailures || 0) + 1;
        await withDeadline(s => this.io.checkpoint(session, s), this.deadlines.checkpoint, 'Monitor did not acknowledge saved progress. Reconnect, then resume.', signal);
        this.patchTimes.push(performance.now() - started); if (this.patchTimes.length > 10) this.patchTimes.shift();
      }
      if (this.io.diagnostics) {
        this.emit('diagnostics', 'Checking the additional measurements included in this mode...');
        await withDeadline(s => this.io.diagnostics(session, mode, s), this.deadlines.diagnostics, 'Additional checks timed out. Resume to retry them.', signal);
      }
      throwIfAborted(signal);
      session.complete = true; session.reason = ''; this.emit('complete', 'Test complete. Review measurement quality and limitations.');
      await this.io.save(session);
      await withDeadline(s => this.io.checkpoint(session, s), this.deadlines.checkpoint, 'Test finished on the phone but its report was not acknowledged. Save JSON or reconnect.', signal);
      this.io.results?.(session); return true;
    } catch (error) {
      if (this.session) {
        // This path also runs with ZERO readings: never just send 'idle'.
        this.session.reason = String(error.message || error).slice(0, 500);
        if (!this.session.complete) this.emit(this.stopPhase, this.session.reason);
        else this.emit('complete', this.session.reason);
        await this.io.save(this.session).catch(() => {});
        this.io.failure?.(this.session.reason, this.session);
      } else this.io.failure?.(error.message, null);
      return false;
    } finally {
      clearInterval(timer); this.clock = this.elapsed(); this.segmentAt = 0;
      if (this.session) this.session.elapsedMs = this.clock;
      if (this.controller === controller) this.controller = null;
      this.dispatchEvent(new Event('finished'));
    }
  }
}
