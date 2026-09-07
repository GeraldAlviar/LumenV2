# Lumen 2.1.0

Experimental monitor checks using **iPhone Safari** as the camera and a second browser as the patch display. Static HTML/CSS/JavaScript; no build step, account, cookies or application backend. Internet access is still required for external pairing dependencies.

**Status: implemented and software-tested; real iPhone Safari and physical display accuracy remain unverified.** Do not describe this as a calibrated colorimeter, a certified calibration system, or a guaranteed Safari hardware fix.

## Start here

For GitHub web-only upload, read **DEPLOY-WEB.md**. Upload the contents of this `lumen` folder, not its parent directory or the ZIP. Keep `index.html`, `desktop.html`, `phone.html`, `css/` and all of `js/` at the repository root. No repository-name edits are required: application links are relative.

For local development with Node 20 or later:

```sh
npm run serve
```

Open `http://127.0.0.1:8080/` and use the simulated report. The local server binds only to localhost. A phone visiting a plain HTTP LAN address cannot use this as a secure camera origin; deploy over HTTPS for the real two-device test.

## What this release addresses

The uploaded V2 phone controller reported errors locally but sent final results only when at least one reading existed. If the first reading failed, its final `idle` message hid the monitor patches without replacing the old `Starting` label. That was a concrete zero-reading error propagation bug. It does not, by itself, establish why the camera stopped producing usable readings in the user's recording.

V2.1 replaces that path with a shared run lifecycle: render acknowledgement, settling, camera sampling, validation, local save and remote checkpoint acknowledgement. A first-reading failure is saved and transmitted as a paused state, even with zero readings. Requests and acquisition have deadlines, stop is cancellable, duplicate starts are ignored and failed patches retry twice.

A second change addresses a possible frame-delivery contributor: the live video stays on-screen during a run. Acquisition normally uses `requestVideoFrameCallback`, with a bounded media-clock fallback when compositor callbacks stop but camera media time is advancing. Frozen frames are not counted as new samples. A suspended camera still pauses the test rather than fabricating data.

## Measurement workflow

1. Open the monitor page over HTTPS. Choose final display settings, disable adaptive/HDR/colour-shifting modes and enter fullscreen before aligning.
2. Open the pairing link in **Safari on an iPhone**, or enter the code manually. Both devices must report `v2.1.0` and protocol 2.
3. Choose Beginner or Advanced, a target/preset and test depth. Standard is preselected.
4. Start the camera. Match the monitor square to the phone guide. The two sample dots must lie inside the two internal patches.
5. Lock sampling and run the exposure check. Perfect alignment is not required. When automatic detection is unavailable, explicitly accept visual alignment; movement detection is then unavailable.
6. Start the test. Keep the phone supported and both pages visible. The square and four corner markers remain in place while the internal patches change.
7. Watch stage, step count and estimated remaining time on both devices. The phone keeps technical details lower down. Pause, stop or resume through the visible controls.
8. Review quality notes, full report structure and exports. Missing measurements are labelled, not invented.

### Test plans and estimates

| Mode | Initial estimate | Grey levels | Unique readings | Additional diagnostics | Total steps |
|---|---|---:|---:|---|---:|
| Quick Check | ~45 seconds | 11 | 20 | Reference ladder and stray-light checks | 20 |
| Standard Test | ~2–3 minutes | 21 | 49 | Colour response and temporal variation | 50 |
| Detailed Test | ~4–5 minutes | 41 | 81 | More colour samples, temporal variation and central-area 5×5 uniformity | 83 |
| Full Test | ~7–10 minutes | 81 | 121 | 17 separated repeat checks, temporal variation and central-area 5×5 uniformity | 140 |

These are design estimates, **not real-iPhone benchmarks**. Setup, pauses and retries are excluded. Remaining time adapts to successful step durations. Full Test is the most extensive experimental check, not a claim of full physical calibration. A support or stand is recommended for all modes.

### Alignment and movement

The monitor square has four constant cyan markers. A local connected-component detector estimates their quadrilateral and maps sample locations through a projective transform. The guide provides position, scale and tilt hints, not a measured distance in centimetres. Lock stays available without a perfect match.

Movement protection is heuristic: three consecutive significant position changes or sustained marker loss pause the run. No motion-sensor permission is needed. Unusual room objects, reflections, colour processing or poor framing can confuse detection. Visual/manual alignment has no automatic movement guarantee. Do not track moving patches with the phone.

### Exposure and clipping

Preflight measures white and grey references, requests supported automatic controls, tries supported exposure reduction when clipped and verifies camera-reported manual modes. Requesting a constraint is not proof it was honoured. Where settings are exposed, large reported exposure/ISO/white-balance changes are rejected during a run. Missing metadata is not treated as successful verification.

Clipping above the software threshold blocks starting or invalidates a reading. The popup explains how to check the sample locations and reflections, retry camera setup, or select a lower **final** monitor brightness and start over. Moving the phone farther away is not presented as a reliable exposure correction. Never change monitor brightness halfway through a saved test.

Safari may not provide exposure or white-balance controls/metadata. Diagnostic results are allowed with prominent warnings, but unconfirmed locks cap quality and block ICC/CAL export. This limitation cannot safely be removed by pretending software can calibrate an unknown camera pipeline.

## Recovery and data

The phone owns acquisition. Both phone and monitor keep complete, versioned checkpoints after completed steps. IndexedDB is preferred; localStorage stores lightweight pointers/preferences and a full fallback if the database is unavailable. Storage failure is shown as memory-only rather than silently claiming persistence.

Checkpoints include session ID, plan signature, target/mode, current step, unique readings, repeat checks, available optional diagnostics, alignment, camera-reported locks, baseline checks and quality/recovery counters. Camera images, pairing credentials and camera device identifiers are not included.

On reconnect or reload, restore the saved test on the phone or send the monitor checkpoint to it. Re-pair, start the camera, realign, pass white/mid-grey reference rechecks, confirm that display settings are unchanged and resume. A reference difference above the software threshold requires a new test rather than merging incompatible measurements. V1 reports remain readable but are not resumable under the new plan.

Browser storage is origin-specific, can be evicted, and may disappear when website data is cleared or private browsing ends. A new run replaces the automatic checkpoint; it is not an unlimited session history. **Export JSON for a durable copy.** Opening a different domain/device does not magically transfer its browser storage. Network signalling and NAT/firewall behaviour can still prevent pairing; no private TURN server is provided.

## Results and exports

The complete report structure is always shown. It includes relative grey response, camera-fit gamma, relative channel drift, apparent contrast, camera colour-response indices, temporal modulation and central-area variation when the chosen plan obtained them. Advanced view exposes raw patch values and retry/movement/recovery counters.

Quick/Standard omissions say which deeper mode contains the diagnostic. Physically unsupported metrics are clearly distinguished: absolute nits, absolute white point/RGB gain corrections, calibrated gamut coverage/display Delta E and full-panel uniformity are **not measured by any current mode**.

The central 5×5 uniformity scan only covers the alignment square. It includes lens shading and viewing-angle effects and is not an isolated backlight or full-screen uniformity measurement. Temporal results are frame-rate-limited variation, not certified flicker safety or a PWM-frequency reading.

Quality levels are Excellent, Good, Fair and Poor (Demo for synthetic data). They describe observed repeatability, **not known measurement accuracy**. They account for incomplete data, clipping/noise, alignment, camera locks, retries, interruptions, resumes and Full repeat drift. Thresholds are engineering heuristics, not experimentally calibrated error bounds.

Available outputs: raw CSV, versioned JSON, standalone HTML report, browser printing and **gated experimental ICC/CAL**. Correction export requires complete reference/grey data, clean readings, confirmed exposure/white-balance locks, adequate repeatability and explicit acknowledgement. The ICC assumes sRGB primaries; it is not a measured monitor characterisation, wide-gamut profile or print-proof profile. No automatic profile installation or monitor RGB-gain adjustment is performed. Keep a copy of the original display profile. Parser acceptance does not prove GPU loading or physical accuracy.

## Development and validation

```sh
npm run check
npm test
```

No npm dependencies are required for those commands. Optional Python tools:

```sh
python tests/dom_smoke.py
python tests/icc_smoke.py
```

The DOM suite needs Playwright plus a Chromium executable; the ICC suite needs Pillow with LittleCMS. `tests/browser_smoke.py` is a compatibility entry point to the same explicitly DOM-only suite, not a separate real-device test. See **TESTING.md** for exact executed checks and the iPhone acceptance checklist.

GitHub Actions runs source and Node regression checks on Node 20/22. This is not a Pages deployment workflow and does not validate a real camera.

### Module map

- `phone.js` / `desktop.js`: UI controllers and inter-device state.
- `runner.js`, `plans.js`, `patches.js`: deterministic plans, retries, cancellation and checkpoints.
- `sensor.js`, `alignment.js`, `preflight.js`: frame sampling, square detection, movement guard and camera readiness.
- `net.js`, `validation.js`, `async.js`: validated transport and bounded operations.
- `storage.js`, `session.js`: local recovery and portable raw data.
- `analysis.js`, `quality.js`, `report.js`, `charts.js`, `icc.js`: experimental analysis, complete reports and export gates.
- `boot.js`, `ui.js`, `version.js`: startup errors, presentation preference and version checks.

### Deployment/cache protection

Production modules and styles are revisioned with `?v=2.1.0`. Pairing checks the app/protocol versions. Upload **all** runtime files together and reload both devices. There is no service worker or offline cache. A partially uploaded or cached old entry page is not a supported combination.

### External dependencies and primary documentation

PeerJS 1.5.4 and QRious 4.0.2 are loaded from the pinned public CDN URLs in HTML; they are not vendored in this archive. PeerJS uses public signalling. Camera images are processed locally, but the application is not a zero-network or fully offline tool.

- Frame callback semantics: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- Camera constraints: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints
- Storage durability/eviction: https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- WebKit media behaviour: https://webkit.org/blog/7763/a-closer-look-into-webrtc/
- GitHub browser uploads: https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
- GitHub Pages source: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
