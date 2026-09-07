// Camera acquisition, disc sampling and bounded, cancellable measurements.
import { srgbToLinear, mean, stdev, clamp } from './colour.js?v=2.2.0';
import { abortError, withDeadline, delay, throwIfAborted } from './async.js?v=2.2.0';
import { project, validQuad } from './alignment.js?v=2.2.0';

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));

export class Sensor extends EventTarget {
  constructor(video, canvas) {
    super();
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
    if (!this.ctx) throw new Error('This browser cannot provide a camera sampling canvas.');
    this.track = null;
    this.stream = null;
    this.caps = {};
    this.locked = { exposure: false, whiteBalance: false, focus: false };
    this.regions = {
      anchor: { x: 0.30, y: 0.50, r: 0.075 },
      test: { x: 0.70, y: 0.50, r: 0.075 },
    };
    this.running = false;
    this.lastFrame = null;
    this._collecting = false;
    this._frameId = null; this._frameKind = null; this._generation = 0; this._watchdog = null;
    this._loopGeneration = 0; this._acceptedTimes = []; this._flow = {};
  }

  async start() {
    this.stop();
    const generation = this._generation;
    if (!globalThis.isSecureContext)
      throw new Error('Camera access needs HTTPS (or localhost). Open the published HTTPS site on your phone.');
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Camera access is unavailable. Open this page in a browser with camera support.');
    try {
      const request = navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 },
          height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }, audio: false,
      });
      request.then(stream => { if (generation !== this._generation) stream.getTracks().forEach(t => t.stop()); }).catch(() => {});
      this.stream = await withDeadline(() => request, 25000, 'Camera permission timed out. Tap Start camera and allow access.');
      if (generation !== this._generation) throw new Error('Camera start cancelled.');
      this.track = this.stream.getVideoTracks()[0];
      this.video.srcObject = this.stream;
      this.video.muted = true; this.video.playsInline = true;
      this.video.setAttribute('playsinline', ''); this.video.setAttribute('muted', '');
      await withDeadline(() => this.video.play(), 5000, 'Camera playback did not start. Keep the preview visible and tap Start camera again.');
      for (let i = 0; i < 20 && !this.video.videoWidth; i++) await delay(100);
      if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('The camera did not supply a usable image.');
      this.caps = this.track.getCapabilities?.() || {};
      this.track.addEventListener?.('ended', () => {
        if (generation !== this._generation) return;
        this.stop();
        this.dispatchEvent(new CustomEvent('error', { detail: new Error('Camera stopped. Start it again to continue.') }));
      }, { once: true });
      this.running = true;
      this._loop();
      return this.caps;
    } catch (error) { this.stop(); throw error; }
  }

  // Preserve current settings, rather than forcing arbitrary exposure/ISO.
  // A requested mode is not a confirmed mode: verify getSettings() afterwards.
  async lockCamera({ signal } = {}) {
    this.locked = { exposure: false, whiteBalance: false, focus: false };
    if (!this.track?.applyConstraints) return this.locked;
    const current = this.track.getSettings?.() || {};
    const accepted = [];
    const tryControl = async (key, mode, extras = {}) => {
      if (!this.caps[mode]?.includes('manual')) return;
      const setting = { [mode]: 'manual', ...extras };
      try {
        await withDeadline(() => this.track.applyConstraints({ ...(this.track.getConstraints?.() || {}), advanced: [...accepted, setting] }), 3000, 'Camera control did not respond.', signal);
        const confirmed = this.track.getSettings?.() || {};
        if (confirmed[mode] === 'manual') accepted.push(setting);
        this.locked[key] = confirmed[mode] === 'manual';
      } catch { /* Report unsupported/automatic, not a successful lock. */ }
    };
    const keep = names => Object.fromEntries(names.filter(n => Number.isFinite(current[n])).map(n => [n, current[n]]));
    await tryControl('exposure', 'exposureMode', keep(['exposureTime', 'iso']));
    await tryControl('whiteBalance', 'whiteBalanceMode', keep(['colorTemperature']));
    await tryControl('focus', 'focusMode', keep(['focusDistance']));
    if (this.caps.torch) {
      try { await withDeadline(() => this.track.applyConstraints({ ...(this.track.getConstraints?.() || {}), advanced: [...accepted, { torch: false }] }), 2000, 'Torch control did not respond.', signal); } catch {}
    }
    const final = this.track.getSettings?.() || {};
    this.locked.exposure = final.exposureMode === 'manual';
    this.locked.whiteBalance = final.whiteBalanceMode === 'manual';
    this.locked.focus = final.focusMode === 'manual';
    return this.locked;
  }

  _cancelLoop() {
    this._loopGeneration++;
    clearInterval(this._watchdog); this._watchdog = null;
    if (this._frameId != null) {
      if (this._frameKind === 'video') this.video.cancelVideoFrameCallback?.(this._frameId);
      else globalThis.cancelAnimationFrame?.(this._frameId);
    }
    this._frameId = null; this._frameKind = null;
  }

  stop() {
    this._generation++; this._cancelLoop();
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null; this.lastFrame = null;
    this._acceptedTimes = [];
    if (this.video.srcObject) this.video.srcObject = null;
    this.dispatchEvent(new Event('stop'));
  }

  // Camera fix 1: a real rVFC notification is not a mediaTime clock tick.
  // Live camera streams can report mediaTime=0 while presentedFrames advances.
  // Polling, unlike rVFC, must prove advancement; wall time alone is not a frame.
  _loop() {
    this._cancelLoop();
    const generation = this._loopGeneration;
    const video = this.video, hasRVFC = typeof video.requestVideoFrameCallback === 'function';
    let lastPresented = null, lastPlaybackCount = null, lastMediaTime = null;
    let lastCallbackSampleAt = performance.now(), playPending = false;
    this._acceptedTimes = []; this._lastStallNotice = performance.now();
    this._flow = { callbacks: 0, accepted: 0, fallbackSamples: 0, rejected: 0,
      lastSource: null, lastMediaTime: null, lastPresentedFrames: null, mode: hasRVFC ? 'video-callback' : 'poll' };
    const active = () => this.running && generation === this._loopGeneration;
    const playbackCount = () => {
      try {
        const value = video.getVideoPlaybackQuality?.().totalVideoFrames;
        if (Number.isFinite(value) && value > 0) return value;
        if (Number.isFinite(video.webkitDecodedFrameCount) && video.webkitDecodedFrameCount > 0) return video.webkitDecodedFrameCount;
      } catch { /* Some camera tracks expose the method but not a useful count. */ }
      return null;
    };
    // Baseline prevents a poll from counting an old decoded frame as a new one.
    lastPlaybackCount = playbackCount();
    lastMediaTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
    const draw = (metadata, source) => {
      if (!active() || globalThis.document?.hidden || video.readyState < 2 ||
          !video.videoWidth || !video.videoHeight || video.paused ||
          this.track?.muted || this.track?.readyState === 'ended') return;
      const callback = source === 'video-callback', count = playbackCount();
      const presented = Number.isFinite(metadata?.presentedFrames) && metadata.presentedFrames > 0 ? metadata.presentedFrames : null;
      const mediaTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
      let fresh;
      if (callback) {
        // A positive frame counter lets us reject duplicate callback metadata.
        // Without one, trust the real callback contract, never a synthetic tick.
        fresh = presented === null || lastPresented === null || presented > lastPresented;
        this._flow.lastMediaTime = metadata?.mediaTime ?? null;
        this._flow.lastPresentedFrames = presented;
      } else if (count !== null) {
        fresh = lastPlaybackCount !== null && count > lastPlaybackCount;
        if (lastPlaybackCount === null) lastPlaybackCount = count;
      } else {
        // Last-resort clock polling is used only when frame counters are absent.
        // A known, frozen callback counter must not be overruled by wall-clock
        // advancement on a MediaStream's currentTime timeline.
        fresh = lastPresented === null && mediaTime !== null && lastMediaTime !== null && mediaTime > lastMediaTime + 0.00001;
      }
      if (!fresh) { this._flow.rejected++; return; }
      const W = 480, H = Math.max(1, Math.round(W * video.videoHeight / video.videoWidth));
      try {
        if (this.canvas.width !== W || this.canvas.height !== H) {
          this.canvas.width = W; this.canvas.height = H; this.dispatchEvent(new Event('resize'));
          if (!active()) return;
        }
        this.ctx.drawImage(video, 0, 0, W, H);
        const frame = this._readBoth();
        // Advance tokens only after the image has been copied successfully.
        if (presented !== null) lastPresented = presented;
        lastPlaybackCount = count; lastMediaTime = mediaTime;
        if (callback) lastCallbackSampleAt = performance.now();
        if (!frame) return;
        this.lastFrame = frame; this._acceptedTimes.push(frame.ts);
        if (this._acceptedTimes.length > 40) this._acceptedTimes.shift();
        this._flow.accepted++; this._flow.lastSource = source;
        if (!callback) this._flow.fallbackSamples++;
        this.dispatchEvent(new CustomEvent('frame', { detail: frame }));
      } catch (error) {
        this.stop(); this.dispatchEvent(new CustomEvent('error', { detail: error }));
      }
    };
    const schedule = () => {
      if (!active()) return;
      this._frameKind = hasRVFC ? 'video' : 'animation';
      this._frameId = hasRVFC ? video.requestVideoFrameCallback(tick) : globalThis.requestAnimationFrame?.(tick);
    };
    const tick = (_now, metadata) => {
      if (!active()) return; this._frameId = null;
      if (hasRVFC) this._flow.callbacks++;
      draw(metadata, hasRVFC ? 'video-callback' : 'poll'); schedule();
    };
    schedule(); // Do not invent an initial callback before the browser provides one.
    this._watchdog = setInterval(() => {
      if (!active() || globalThis.document?.hidden) return;
      if (video.paused && !playPending) {
        playPending = true;
        Promise.resolve().then(() => video.play()).catch(() => {}).finally(() => { playPending = false; });
      }
      // Recovery is keyed to ACCEPTED callback samples, not callbacks discarded
      // by metadata checks. Once active, polling runs up to 20 times per second.
      if (!hasRVFC || performance.now() - lastCallbackSampleAt > 450) draw(null, 'poll');
      const age = this.lastFrame ? performance.now() - this.lastFrame.ts : Infinity;
      if (age > 2500 && performance.now() - this._lastStallNotice > 3000) {
        this._lastStallNotice = performance.now();
        const error = new Error('No fresh camera frames. Keep Safari and its preview visible, then tap Retry camera. Alignment is not the cause of missing frames.');
        error.code = 'CAMERA_NO_FRAMES';
        this.dispatchEvent(new CustomEvent('stall', { detail: error }));
      }
    }, 50);
  }

  frameDiagnostics() {
    return { fix: 'camera-fix-1', ...this._flow,
      frameAgeMs: this.lastFrame ? Math.round(performance.now() - this.lastFrame.ts) : null,
      paused: Boolean(this.video.paused), readyState: this.video.readyState ?? null,
      width: this.video.videoWidth || 0, height: this.video.videoHeight || 0,
      trackState: this.track?.readyState ?? null, muted: Boolean(this.track?.muted) };
  }

  // Used by the phone controller; explicit measure() deadlines remain exact.
  measurementBudget(minSamples, requestedMs) {
    const times = this._acceptedTimes;
    if (!Number.isFinite(requestedMs) || !Number.isInteger(minSamples) ||
        times.length < 4 || performance.now() - times.at(-1) > 2000) return requestedMs;
    const intervals = times.slice(1).map((t, i) => t - times[i]).filter(t => t > 0).sort((a, b) => a - b);
    if (!intervals.length) return requestedMs;
    const interval = intervals[Math.floor((intervals.length - 1) * .8)];
    return Math.max(requestedMs, Math.min(12000, Math.ceil(minSamples * interval * 1.5 + 750)));
  }

  waitForFrame({ timeoutMs = 5000, signal, minFrames = 1 } = {}) {
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (!this.running) return Promise.reject(new Error('Start the camera first.'));
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return; done = true; clearTimeout(timer);
        this.removeEventListener('frame', frame); this.removeEventListener('stop', stopped);
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(value);
      };
      let received = 0;
      const frame = event => { if (event.detail && ++received >= minFrames) finish(null, event.detail); };
      const stopped = () => finish(new Error('Camera stopped before a fresh frame arrived.'));
      const cancel = () => finish(abortError(signal.reason));
      const timer = setTimeout(() => {
        const error = new Error('No fresh camera frames after retry. Tap Restart camera to open a new camera stream.');
        error.code = 'CAMERA_NO_FRAMES'; finish(error);
      }, timeoutMs);
      this.addEventListener('frame', frame); this.addEventListener('stop', stopped, { once: true });
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }

  async recover({ signal, timeoutMs = 6000 } = {}) {
    throwIfAborted(signal);
    if (this._collecting) throw new Error('Pause the measurement before retrying the camera.');
    if (!this.running || !this.track || this.track.readyState === 'ended')
      throw new Error('The camera stream ended. Restart camera to open it again.');
    this.video.muted = true; this.video.playsInline = true;
    // Call play from the user's retry action, not a background permission prompt.
    await withDeadline(() => this.video.play(), 3000, 'Camera playback could not resume. Restart camera.', signal);
    throwIfAborted(signal);
    this.lastFrame = null;
    this._loop();
    // Require progress beyond the first callback after resetting counters.
    // Otherwise one cached/stale initial callback could falsely claim recovery.
    await this.waitForFrame({ timeoutMs, signal, minFrames: 2 });
    return this.frameDiagnostics();
  }

  image() { return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height); }

  async lowerExposure(signal) {
    throwIfAborted(signal);
    if (!this.track?.applyConstraints) return false;
    const now = this.track.getSettings?.() || {}, cap = this.caps;
    let key, value;
    if (cap.exposureCompensation && Number.isFinite(now.exposureCompensation)) {
      key = 'exposureCompensation'; value = Math.max(cap[key].min, now[key] - Math.max(cap[key].step || 0.5, 0.5));
    } else if (cap.exposureTime && cap.exposureMode?.includes('manual') && Number.isFinite(now.exposureTime)) {
      key = 'exposureTime'; value = Math.max(cap[key].min, now[key] * 0.7);
    } else return false;
    if (!Number.isFinite(value) || value >= now[key]) return false;
    const controls = { [key]: value, ...(key === 'exposureTime' ? { exposureMode: 'manual' } : {}) };
    await withDeadline(() => this.track.applyConstraints({ ...(this.track.getConstraints?.() || {}), advanced: [controls] }), 3000, 'Exposure control did not respond.', signal);
    const after = this.track.getSettings?.() || {};
    return Number.isFinite(after[key]) && after[key] < now[key];
  }

  // Locked alignment samples are squares inside the patches. Legacy callers and
  // the uniformity grid may still request a disc.
  _sampleRegion(reg) {
    const W = this.canvas.width, H = this.canvas.height;
    const cx = reg.x * W, cy = reg.y * H;
    const rad = reg.r * Math.min(W, H);
    if (![cx, cy, rad].every(Number.isFinite) || rad <= 0) return null;
    const x0 = Math.max(0, Math.floor(cx - rad));
    const y0 = Math.max(0, Math.floor(cy - rad));
    const w = Math.min(W - x0, Math.ceil(cx + rad) - x0);
    const h = Math.min(H - y0, Math.ceil(cy + rad) - y0);
    if (w <= 0 || h <= 0) return null;
    const img = this.ctx.getImageData(x0, y0, w, h).data;
    let lr = 0, lg = 0, lb = 0, n = 0, clipped = 0;
    const lumas = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x0 + x - cx, dy = y0 + y - cy;
        if (reg.shape !== 'square' && dx * dx + dy * dy > rad * rad) continue;
        const i = (y * w + x) * 4;
        const r8 = img[i], g8 = img[i + 1], b8 = img[i + 2];
        if (r8 >= 252 || g8 >= 252 || b8 >= 252) clipped++;
        // Apply the assumed inverse-sRGB transfer before averaging. This
        // does not establish that the actual camera pipeline is linear.
        const r = LINEAR[r8];
        const g = LINEAR[g8];
        const b = LINEAR[b8];
        lr += r; lg += g; lb += b; n++;
        lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
      }
    }
    if (!n) return null;
    const linear = [lr / n, lg / n, lb / n];
    return {
      linear,
      luma: 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2],
      // Uniformity within the sample disc. High values mean the reticle is
      // straddling an edge or the phone moved.
      noise: stdev(lumas) / (mean(lumas) || 1e-9),
      clipping: clipped / n,
      pixels: n,
    };
  }

  _readBoth() {
    const a = this._sampleRegion(this.regions.anchor);
    const t = this._sampleRegion(this.regions.test);
    if (!a || !t) return null;
    // Ratios cancel shared multiplicative gains in an ideal linear pipeline.
    // Clipping, offsets, local tone mapping and an unknown camera response do
    // not cancel. Results remain experimental, even when a reading is stable.
    const ratio = [0, 1, 2].map(i => t.linear[i] / Math.max(a.linear[i], 1e-6));
    return {
      anchor: a,
      test: t,
      ratio,
      lumaRatio: t.luma / Math.max(a.luma, 1e-9),
      clipping: Math.max(a.clipping, t.clipping),
      noise: Math.max(a.noise, t.noise),
      ts: performance.now(),
    };
  }

  // Collection has a real deadline, independent of whether another frame
  // arrives. One frame followed by a stalled camera cannot leave a pending promise.
  _collect({ settleMs = 0, maxMs, signal, onSample, onDeadline }) {
    if (!this.running) return Promise.reject(new Error('Start the camera first.'));
    if (this._collecting) return Promise.reject(new Error('Another camera measurement is already active.'));
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    this._collecting = true;
    return new Promise((resolve, reject) => {
      let done = false, lastTs = -Infinity;
      const starts = performance.now() + settleMs;
      const frames = [];
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.removeEventListener('stop', stopped);
        this.removeEventListener('frame', frame);
        this._collecting = false;
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(abortError(signal.reason));
      const stopped = () => finish(new Error('Camera stopped during measurement.'));
      const frame = e => {
        const f = e.detail;
        if (!f || performance.now() < starts || f.ts <= lastTs || !Number.isFinite(f.lumaRatio)) return;
        lastTs = f.ts;
        frames.push(f);
        if (frames.length > 2000) frames.shift();
        try { const value = onSample?.(frames); if (value !== undefined) finish(null, value); }
        catch (error) { finish(error); }
      };
      const timer = setTimeout(() => {
        try { finish(null, onDeadline(frames)); } catch (error) { finish(error); }
      }, settleMs + maxMs);
      signal?.addEventListener('abort', cancel, { once: true });
      this.addEventListener('stop', stopped, { once: true });
      this.addEventListener('frame', frame);
    });
  }

  measure({ settleMs = 900, minSamples = 24, maxMs = 9000, tolerance = 0.006, signal } = {}) {
    if (!Number.isInteger(minSamples) || minSamples < 2 || minSamples > 90 ||
        !Number.isFinite(maxMs) || maxMs <= 0 || !Number.isFinite(settleMs) || settleMs < 0 ||
        !Number.isFinite(tolerance) || tolerance <= 0) return Promise.reject(new Error('Invalid measurement options.'));
    const variation = frames => Math.max(...[0, 1, 2].map(c => {
      const values = frames.map(f => f.ratio[c]);
      return stdev(values) / Math.max(mean(values), 0.002);
    }));
    const exposureVariation = frames => {
      const values = frames.map(f => f.anchor.luma ?? mean(f.anchor.linear));
      return stdev(values) / Math.max(mean(values), 0.0001);
    };
    const summarise = (frames, converged) => ({
      ratio: [0, 1, 2].map(c => mean(frames.map(f => f.ratio[c]))),
      lumaRatio: mean(frames.map(f => f.lumaRatio)),
      stability: variation(frames), exposureDrift: exposureVariation(frames),
      clipping: Math.max(...frames.map(f => f.clipping)),
      noise: mean(frames.map(f => f.noise)), samples: frames.length, converged,
      anchorLinear: [0, 1, 2].map(c => mean(frames.map(f => f.anchor.linear[c]))),
      testLinear: [0, 1, 2].map(c => mean(frames.map(f => f.test.linear[c]))),
    });
    return this._collect({ settleMs, maxMs, signal,
      onSample: frames => {
        if (frames.length < minSamples) return;
        const recent = frames.slice(-minSamples);
        if (variation(recent) < tolerance && exposureVariation(recent) < 0.02) return summarise(recent, true);
      },
      onDeadline: frames => {
        if (frames.length < minSamples) {
          const stale = !frames.length || performance.now() - frames.at(-1).ts > 1500;
          const error = new Error(`${stale ? 'Camera stalled' : 'Camera sampling is slow'}: ${frames.length} of ${minSamples} required fresh frames received within ${(maxMs / 1000).toFixed(1)} seconds. Tap Retry camera; more precise alignment will not fix missing frames.`);
          error.code = stale ? 'CAMERA_NO_FRAMES' : 'CAMERA_SLOW_FRAMES';
          error.received = frames.length; error.required = minSamples; error.captureMs = maxMs;
          throw error;
        }
        return summarise(frames.slice(-minSamples), false);
      },
    });
  }

  // Frame-rate-limited temporal modulation, not a PWM frequency detector.
  // Automatic exposure, aliasing, rolling shutter and lighting can all affect it.
  flickerScan(ms = 5000, { signal } = {}) {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new Error('Invalid scan duration.'));
    return this._collect({ settleMs: 1000, maxMs: ms, signal,
      onDeadline: frames => {
        if (frames.length < 12) throw new Error('Not enough camera frames for a modulation check.');
        if (Math.max(...frames.map(f => f.clipping)) > 0.02) throw new Error('Camera clipping invalidated the modulation check. Retry camera setup; changed monitor brightness requires a new test.');
        const v = frames.map(f => f.test.luma), avg = mean(v);
        if (avg < 0.0001) throw new Error('The test patch is too dark for a modulation check.');
        const lo = Math.min(...v), hi = Math.max(...v);
        const modulationDepth = (hi - lo) / Math.max(hi + lo, 1e-9);
        const elapsed = frames.at(-1).ts - frames[0].ts;
        if (elapsed <= 0) throw new Error('Invalid camera timestamps.');
        return {
          samples: frames.length, sampleHz: 1000 * (frames.length - 1) / elapsed,
          modulationDepth, rms: stdev(v) / avg,
          verdict: modulationDepth > 0.04 ? 'Temporal variation detected; cause is not identified'
            : 'Low variation at the sampled frame rate; high-frequency flicker is not ruled out',
        };
      },
    });
  }

  // A conditional camera-field diagnostic; never described as calibrated
  // whole-panel uniformity. All four field corners must be visible.
  projectedGrid(q, rows = 3) {
    if (!validQuad(q) || !this.lastFrame || performance.now() - this.lastFrame.ts > 1200) throw new Error('Uniformity needs a fresh frame and four visible corners.');
    const W = this.canvas.width, H = this.canvas.height, cells = [];
    for (let row = 0; row < rows; row++) for (let col = 0; col < rows; col++) {
      const u = (col + 0.5) / rows, v = (row + 0.5) / rows, centre = project(q, u, v), edge = project(q, u + 0.14 / rows, v);
      const r = Math.hypot((edge.x - centre.x) * W, (edge.y - centre.y) * H) / Math.min(W, H);
      const sample = this._sampleRegion({ ...centre, r });
      if (!sample || sample.clipping > 0.02 || sample.luma < 0.0001) throw new Error('Uniformity is clipped or too dark.');
      cells.push({ row, col, luma: sample.luma, linear: sample.linear });
    }
    const centre = cells[Math.floor(rows / 2) * rows + Math.floor(rows / 2)].luma;
    cells.forEach(c => { c.relative = c.luma / centre; c.deviation = (c.relative - 1) * 100; });
    const values = cells.map(c => c.luma);
    return { rows, cols: rows, cells, corners: q, coverage: 'Visible display field, excluding the status strip and marker border',
      worstDeviation: Math.max(...cells.map(c => Math.abs(c.deviation))), spread: (Math.max(...values) - Math.min(...values)) / Math.max(...values) * 100 };
  }

  // Screen bounds are explicitly aligned in the preview. Front-on placement is
  // required; perspective and lens shading remain uncorrected.
  uniformityGrid(rows = 5, cols = 5, bounds = { x: 0.08, y: 0.08, w: 0.84, h: 0.84 }) {
    if (!this.running || !this.lastFrame || performance.now() - this.lastFrame.ts > 1500)
      throw new Error('No recent camera frame. Keep the camera running.');
    if (![rows, cols].every(n => Number.isInteger(n) && n > 0 && n <= 9)) throw new Error('Invalid grid size.');
    const { x, y, w, h } = bounds;
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 0.1 || h < 0.1 || x + w > 1.001 || y + h > 1.001)
      throw new Error('Align the rectangle within the preview.');
    const W = this.canvas.width, H = this.canvas.height;
    const radius = Math.min(w * W / cols, h * H / rows) * 0.2 / Math.min(W, H);
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const s = this._sampleRegion({ x: x + (c + 0.5) * w / cols, y: y + (r + 0.5) * h / rows, r: radius });
      if (!s || s.clipping > 0.02) throw new Error('Clipping or an invalid sample in the uniformity field.');
      cells.push({ row: r, col: c, luma: s.luma, linear: s.linear });
    }
    const centre = cells[Math.floor(rows / 2) * cols + Math.floor(cols / 2)].luma;
    if (centre < 0.0001) throw new Error('Centre of screen is too dark. Check screen alignment.');
    cells.forEach(c => { c.relative = c.luma / centre; c.deviation = (c.relative - 1) * 100; });
    const lumas = cells.map(c => c.luma);
    return { cells, rows, cols, bounds, worstDeviation: Math.max(...cells.map(c => Math.abs(c.deviation))),
      spread: (Math.max(...lumas) - Math.min(...lumas)) / Math.max(...lumas) * 100, dimensions: { W, H } };
  }
}
