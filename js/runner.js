// One measurement owner. User choices are separate from camera/network deadlines.
import { withDeadline, delay, throwIfAborted, abortError } from './async.js?v=2.2.0';
import { MODES, verifyResume, planFor, PLAN_VERSION } from './modes.js?v=2.2.0';
import { CaptureError, captureIssues, blockers, rememberWarnings, issue, referenceDrift } from './capture.js?v=2.2.0';
import { newSessionId, createSession } from './session.js?v=2.2.0';
import { MAX_RETRIES } from './config.js?v=2.2.0';

export class TestRunner extends EventTarget {
  constructor(io, { retries = MAX_RETRIES, deadlines = {} } = {}) {
    super(); this.io = io; this.retries = retries;
    this.deadlines = { begin: 6500, preflight: 35000, render: 6000, measureExtra: 1000, checkpoint: 6500, diagnostics: 30000, retry: 300, review: 300000, ...deadlines };
    this.session = null; this.controller = null; this.phase = 'idle'; this.revision = 0;
    this.liveLabel = ''; this.clock = 0; this.segmentAt = 0; this.patchTimes = [];
  }
  get busy() { return Boolean(this.controller); }
  restore(data) {
    if (this.busy) throw new Error('Pause the active test before restoring another one.');
    verifyResume(data); this.session = createSession(data); this.session.phase = 'paused'; this.phase = 'paused';
    this.clock = this.session.elapsedMs || 0; this.emit('paused', 'Recovered progress. Position the samples, then resume.');
  }
  elapsed() { return this.clock + (this.segmentAt ? performance.now() - this.segmentAt : 0); }
  remaining() {
    if (!this.session) return 0;
    const mode = MODES[this.session.run], n = this.session.expected - this.session.readings.length;
    const per = this.patchTimes.length ? this.patchTimes.reduce((a, b) => a + b, 0) / this.patchTimes.length / 1000 : (this.session.purpose === 'verification' ? 60 : (mode.seconds[0] + mode.seconds[1]) / 2) / this.session.expected;
    return Math.max(0, n * per + (this.session.purpose !== 'verification' && mode.uniformity && !this.session.uniformity && !this.session.omissions.uniformity ? 8 : 0) + (this.session.purpose !== 'verification' && mode.temporal && !this.session.flicker && !this.session.omissions.temporal ? 6 : 0));
  }
  emit(phase = this.phase, label = this.liveLabel) {
    if (!this.session) return;
    this.phase = phase; this.liveLabel = String(label).slice(0, 500); this.session.phase = phase;
    this.session.elapsedMs = this.elapsed();
    const status = { t: 'run-state', sessionId: this.session.sessionId, phase, label: this.liveLabel,
      done: this.session.readings.length, total: this.session.expected, remaining: phase === 'complete' ? 0 : this.remaining(), elapsedMs: this.session.elapsedMs, revision: ++this.revision };
    this.io.notify?.(status); this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }
  pause(reason = 'Paused. Position the samples again before resuming.', metric) {
    if (!this.controller) return;
    if (metric && this.session) this.session.telemetry[metric] = (this.session.telemetry[metric] || 0) + 1;
    this.stopPhase = 'paused'; this.controller.abort(abortError(reason));
  }
  stop(reason = 'Stopped. Completed readings are saved.') {
    if (this.controller) { this.stopPhase = 'stopped'; this.controller.abort(abortError(reason)); }
    else if (this.session) { this.session.reason = reason; this.emit('stopped', reason); this.io.save?.(this.session); }
  }
  async review(issues, stage, signal) {
    const fatal = blockers(issues);
    rememberWarnings(this.session, issues, stage);
    if (fatal.length) throw new CaptureError(fatal);
    if (this.session.capture?.diagnosticOnly) { rememberWarnings(this.session, issues, stage, true); return 'continue'; }
    if (!this.io.review) throw new CaptureError(issues);
    this.emit('review', `${issues[0].title}. On the phone: retry, continue with warnings, or stop.`);
    const choice = await withDeadline(s => this.io.review({ issues, stage }, s), this.deadlines.review,
      'No choice was made for five minutes. Progress is saved. Resume when ready.', signal);
    throwIfAborted(signal);
    if (choice === 'continue') { rememberWarnings(this.session, issues, stage, true); return choice; }
    if (choice === 'retry') return choice;
    this.stopPhase = 'stopped'; throw abortError('Stopped while reviewing capture warnings. Readings are saved.');
  }
  async start({ run = 'standard', target = 'gamma22', resume = false, comparison = null } = {}) {
    if (this.busy) return false;
    const controller = new AbortController(); this.controller = controller; this.stopPhase = 'paused';
    const signal = controller.signal; let timer;
    try {
      if (resume) verifyResume(this.session);
      else {
        if (!MODES[run]) throw new Error('Unknown test mode.');
        this.clock = 0; this.patchTimes = [];
        const purpose = comparison ? 'verification' : 'assessment';
        this.session = createSession({ run, target, purpose, comparison, planVersion: PLAN_VERSION, sessionId: newSessionId(), expected: planFor(run, purpose).length,
          readings: [], complete: false, phase: 'preflight', telemetry: {}, omissions: {} });
      }
      const session = this.session, mode = MODES[session.run], plan = planFor(session.run, session.purpose);
      session.reason = ''; session.complete = false; this.segmentAt = performance.now();
      this.emit('starting', 'Checking that both devices are ready...');
      timer = setInterval(() => this.emit(), 1000);
      await withDeadline(s => this.io.begin(session, s), this.deadlines.begin, 'Monitor did not acknowledge the test. Reconnect both pages.', signal);
      for (;;) {
        this.emit('preflight', resume ? 'Rechecking the saved reference...' : 'Checking camera frames and exposure. Geometry is already locked.');
        const baseline = await withDeadline(s => this.io.preflight(session, s, resume), this.deadlines.preflight, 'Camera setup timed out. Restart the camera or retry setup.', signal);
        throwIfAborted(signal);
        if (baseline.warnings?.length && await this.review(baseline.warnings, 'setup', signal) === 'retry') continue;
        if (!session.baseline) session.baseline = { ratio: baseline.ratio, anchorLinear: baseline.anchorLinear };
        break;
      }
      if (resume) session.telemetry.resumes = (session.telemetry.resumes || 0) + 1;
      await this.io.save(session);
      for (let index = session.readings.length; index < plan.length; index++) {
        const patch = plan[index]; let reading; const started = performance.now();
        for (let attempt = 0;; attempt++) {
          throwIfAborted(signal);
          try {
            this.emit('rendering', `${index + 1}/${plan.length}: ${patch.label}`);
            await withDeadline(s => this.io.render(patch, s), this.deadlines.render, 'Monitor did not confirm the displayed patch.', signal);
            this.emit('settling', `${patch.label} - keep the phone still`); await delay(mode.sample.settleMs, signal);
            this.emit('sampling', `${patch.label} - collecting camera frames`);
            const result = await withDeadline(s => this.io.measure({ ...mode.sample, settleMs: 0, signal: s }), mode.sample.maxMs + this.deadlines.measureExtra,
              'Camera stopped supplying frames. Keep Safari and the preview visible.', signal);
            throwIfAborted(signal); this.emit('checking', `Validating ${patch.label}`);
            reading = { patch, result };
            const issues = captureIssues(reading);
            session.telemetry.maxDrift = Math.max(session.telemetry.maxDrift || 0, result.exposureDrift || 0);
            if (result.clipping > 0.02) session.telemetry.clipping = (session.telemetry.clipping || 0) + 1;
            if (patch.kind === 'reference') {
              const first = session.readings.find(r => r.patch.kind === 'reference');
              const drift = referenceDrift(result, first?.result);
              session.telemetry.referenceDrift = Math.max(session.telemetry.referenceDrift || 0, drift);
              if (drift > 0.08) issues.push(issue('reference-drift', 'The repeated camera reference changed', `The test/reference ratio differs by ${(drift * 100).toFixed(1)}%. Retry or continue as a diagnostic. Lumen will not silently compensate or treat this as stable calibration.`));
            }
            if (issues.length) {
              // Retry noisy samples first. An accepted diagnostic policy still
              // checks severe clipping and missing signal on EVERY patch.
              if (attempt < this.retries && !session.capture?.diagnosticOnly) throw new CaptureError(issues);
              const choice = await this.review(issues, patch.kind === 'reference' ? 'reference' : 'measurement', signal);
              if (choice === 'retry') { attempt = -1; continue; }
            }
            if (patch.kind === 'reference') session.telemetry.referenceChecks = (session.telemetry.referenceChecks || 0) + 1;
            break;
          } catch (error) {
            throwIfAborted(signal);
            if (attempt >= this.retries || error.name === 'AbortError') throw error;
            session.telemetry.retries = (session.telemetry.retries || 0) + 1;
            this.emit('retrying', `Retry ${attempt + 1}/${this.retries}: ${error.message}`);
            await delay(this.deadlines.retry, signal);
          }
        }
        throwIfAborted(signal); session.readings.push(reading);
        this.emit('saving', `Received ${index + 1}/${plan.length}. Saving on both devices...`);
        const local = await this.io.save(session);
        if (local?.saved === false) session.telemetry.storageFailures = (session.telemetry.storageFailures || 0) + 1;
        await withDeadline(s => this.io.checkpoint(session, s), this.deadlines.checkpoint, 'Monitor did not acknowledge saved progress. Reconnect, then resume.', signal);
        this.patchTimes.push(performance.now() - started); if (this.patchTimes.length > 10) this.patchTimes.shift();
      }
      if (this.io.diagnostics && session.purpose !== 'verification') {
        this.emit('diagnostics', 'Checking the additional measurements included in this mode...');
        await withDeadline(s => this.io.diagnostics(session, mode, s), this.deadlines.diagnostics, 'Additional checks timed out. Resume to retry them.', signal);
      }
      throwIfAborted(signal); session.complete = true; session.reason = '';
      this.emit('complete', session.capture.diagnosticOnly ? 'Diagnostic report complete. Accepted warnings are recorded; correction exports are unavailable.' : 'Test complete. Review measurement quality and limitations.');
      await this.io.save(session);
      await withDeadline(s => this.io.checkpoint(session, s), this.deadlines.checkpoint, 'Test finished on the phone but its report was not acknowledged. Save JSON or reconnect.', signal);
      this.io.results?.(session); return true;
    } catch (error) {
      if (this.session) {
        this.session.reason = String(error.message || error).slice(0, 500);
        this.emit(this.session.complete ? 'complete' : this.stopPhase, this.session.reason);
        await this.io.save(this.session).catch(() => {});
        this.io.failure?.(this.session.reason, this.session, error);
      } else this.io.failure?.(error.message, null, error);
      return false;
    } finally {
      clearInterval(timer); this.clock = this.elapsed(); this.segmentAt = 0;
      if (this.session) this.session.elapsedMs = this.clock;
      if (this.controller === controller) this.controller = null;
      this.dispatchEvent(new Event('finished'));
    }
  }
}
