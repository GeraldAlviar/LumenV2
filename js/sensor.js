// Camera acquisition, disc sampling and bounded, cancellable measurements.
import { srgbToLinear, mean, stdev, clamp } from './colour.js';
import { abortError } from './async.js';

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
    this._frameId = null;
  }

  async start() {
    this.stop();
    if (!globalThis.isSecureContext)
      throw new Error('Camera access needs HTTPS (or localhost). Open the published HTTPS site on your phone.');
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error('Camera access is unavailable. Open this page in a browser with camera support.');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 },
          height: { ideal: 720 }, frameRate: { ideal: 60 } }, audio: false,
      });
      this.track = this.stream.getVideoTracks()[0];
      this.video.srcObject = this.stream;
      await this.video.play();
      if (!this.video.videoWidth || !this.video.videoHeight) throw new Error('The camera did not supply a usable image.');
      this.caps = this.track.getCapabilities?.() || {};
      this.track.addEventListener?.('ended', () => {
        this.stop();
        this.dispatchEvent(new CustomEvent('error', { detail: new Error('Camera stopped. Start it again to continue.') }));
      }, { once: true });
      this.running = true;
      this._lastMediaTime = -1;
      this._loop();
      return this.caps;
    } catch (error) { this.stop(); throw error; }
  }

  // Preserve current settings, rather than forcing arbitrary exposure/ISO.
  // A requested mode is not a confirmed mode: verify getSettings() afterwards.
  async lockCamera() {
    this.locked = { exposure: false, whiteBalance: false, focus: false };
    if (!this.track?.applyConstraints) return this.locked;
    const current = this.track.getSettings?.() || {};
    const accepted = [];
    const tryControl = async (key, mode, extras = {}) => {
      if (!this.caps[mode]?.includes('manual')) return;
      const setting = { [mode]: 'manual', ...extras };
      try {
        await this.track.applyConstraints({ advanced: [...accepted, setting] });
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
      try { await this.track.applyConstraints({ advanced: [...accepted, { torch: false }] }); } catch {}
    }
    const final = this.track.getSettings?.() || {};
    this.locked.exposure = final.exposureMode === 'manual';
    this.locked.whiteBalance = final.whiteBalanceMode === 'manual';
    this.locked.focus = final.focusMode === 'manual';
    return this.locked;
  }

  stop() {
    this.running = false;
    if (this._frameId != null) {
      if (this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._frameId);
      else globalThis.cancelAnimationFrame?.(this._frameId);
    }
    this._frameId = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.track = null;
    this.lastFrame = null;
    if (this.video.srcObject) this.video.srcObject = null;
    this.dispatchEvent(new Event('stop'));
  }

  _loop() {
    const draw = (_now, metadata) => {
      if (!this.running) return;
      const mediaTime = metadata?.mediaTime ?? this.video.currentTime;
      if (this.video.readyState >= 2 && mediaTime !== this._lastMediaTime) {
        this._lastMediaTime = mediaTime;
        const W = 480, H = Math.max(1, Math.round(W * this.video.videoHeight / this.video.videoWidth));
        if (this.canvas.width !== W || this.canvas.height !== H) {
          this.canvas.width = W; this.canvas.height = H;
          this.dispatchEvent(new Event('resize'));
        }
        try {
          this.ctx.drawImage(this.video, 0, 0, W, H);
          this.lastFrame = this._readBoth();
          this.dispatchEvent(new CustomEvent('frame', { detail: this.lastFrame }));
        } catch (error) {
          this.stop();
          this.dispatchEvent(new CustomEvent('error', { detail: error }));
          return;
        }
      }
      this._frameId = this.video.requestVideoFrameCallback
        ? this.video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    draw();
  }

  // Sample a disc rather than a square. Rectangular crops catch patch borders
  // when alignment is slightly off; a disc degrades more gracefully.
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
        if (dx * dx + dy * dy > rad * rad) continue;
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
      return stdev(values) / Math.max(mean(values), 1e-6);
    }));
    const summarise = (frames, converged) => ({
      ratio: [0, 1, 2].map(c => mean(frames.map(f => f.ratio[c]))),
      lumaRatio: mean(frames.map(f => f.lumaRatio)),
      stability: variation(frames),
      clipping: Math.max(...frames.map(f => f.clipping)),
      noise: mean(frames.map(f => f.noise)), samples: frames.length, converged,
      anchorLinear: [0, 1, 2].map(c => mean(frames.map(f => f.anchor.linear[c]))),
      testLinear: [0, 1, 2].map(c => mean(frames.map(f => f.test.linear[c]))),
    });
    return this._collect({ settleMs, maxMs, signal,
      onSample: frames => {
        if (frames.length < minSamples) return;
        const recent = frames.slice(-minSamples);
        if (variation(recent) < tolerance) return summarise(recent, true);
      },
      onDeadline: frames => {
        if (frames.length < minSamples) throw new Error(`Camera stalled: ${frames.length} of ${minSamples} required frames received.`);
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
        if (Math.max(...frames.map(f => f.clipping)) > 0.02) throw new Error('Camera clipping invalidated the modulation check. Lower brightness.');
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
