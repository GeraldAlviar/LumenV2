# Changelog

## 2.1.0 - recoverable iPhone workflow

Built from the uploaded improved V2 snapshot. This is a local release package, not a pushed GitHub commit.

### Fixes

- Failed first readings now produce a saved paused checkpoint and visible errors on both devices, even when zero samples completed.
- The monitor no longer silently hides patches while retaining an obsolete Starting label.
- Bounded render, camera, pairing and checkpoint waits; two retries; shared progress; cancellation and duplicate-run prevention.
- Visible compact camera preview and advancing-media-clock fallback for missing compositor callbacks; actual frozen cameras still pause.
- Verified camera lock reporting, clipping preflight/remediation, exposed-setting drift rejection and version mismatch protection.
- Correct persistent square geometry, fixed sampling regions, heuristic movement/lost-marker pause and explicit manual fallback.
- Complete reports clear stale errors/charts; non-measured metrics remain visible; correction exports cannot bypass camera lock/quality gates.

### Added

- Quick, Standard (Recommended), Detailed and Full plans with initial and dynamic time estimates.
- Matching phone/monitor square guides, automatic position/scale/tilt feedback and optional imperfect alignment.
- Beginner/Advanced presentation; preset/technical target optgroups; phone and monitor stage/progress/ETA.
- Versioned IndexedDB checkpoints on both devices, localStorage fallback, monitor-to-phone recovery, JSON import and safe rechecks before resume.
- Central-area 5x5 variation and Full separated repeat checks, with limitations explicitly labelled.
- Quality/repeatability grading, recommendations, raw advanced table and standalone HTML report export.
- Regression tests, current GitHub web deployment instructions and a real-iPhone acceptance checklist.

### Remaining limitations

Real iPhone Safari, external signalling/WebRTC, physical measurement accuracy and OS calibration loading have not been validated for this release. Safari camera controls may remain unavailable. Absolute nits, white point, calibrated gamut/Delta E and full-panel uniformity are not measured. Timing/quality thresholds are not empirical accuracy guarantees.

---

## Previous supplied release notes (historical)

# Changes in 1.1.0

This revision was implemented against the Lumen source contained in the supplied
`files.zip` / `lumen.zip` archive. It is a local source update, not a GitHub push.

## Measurement reliability

- Real wall-clock sample deadlines, including a stream that delivers a few frames
  and then stalls. Abortable render requests, settling waits and sample windows.
- One camera operation at a time, with controls locked while busy. Stop, Escape,
  hidden-page and connection-loss handling preserve completed readings.
- New video frames are deduplicated; channel-specific instability is checked.
  Camera shutdown releases tracks and pending collectors.
- Camera locking preserves current settings where possible and verifies actual
  reported modes rather than assuming an accepted request took effect.
- Preview geometry matches the video aspect ratio. Circular reticles match the
  true sensor sampling discs, remain inside the image, support pointer and keyboard
  movement, and preserve the selected sample size when restarting the camera.
- Uniformity uses a separately aligned screen rectangle and explicit capture.
  Stale frames, dark centres and clipping are rejected.

## Pairing and protocol

- Cryptographically generated five-character room codes; validated inputs and a
  single phone per display session.
- Bounded host/join and render requests, cancellation, heartbeat checks, cleanup
  and immediate rejection of pending requests when a link closes.
- Generation guards prevent an old connection from replacing/closing the new one.
  Malformed messages, oversized inputs and stale acknowledgements are rejected.
- Copyable pairing link, retry/new-code action and manual-code fallback when QR
  rendering is unavailable. QRious replaces the previous QR script integration.

## Analysis and safer exports

- Dark patches use the nearest higher ladder reference instead of defaulting to
  full white for nearly every reading. Every run includes its required references.
- Missing ladder data is an error rather than a nominal linear fallback.
- Stray-light slope is fitted in reconstructed linear anchor brightness.
- Gamma fitting subtracts the estimated black offset before normalisation.
  Missing black, full-white or adequate fit data is explicitly handled.
- Per-channel correction inversion uses monotonic regression in signal order.
  Invalid correction curves are rejected and exported tables are resampled.
- sRGB ICC tone curves use the piecewise transfer curve; profile descriptions,
  binary structure and calibration-table inputs are checked.
- CSV labels are properly quoted and protected from formula interpretation.
- Complete-run/reference, convergence, sample-count, clipping, stability and noise
  gates control correction export. An explicit experimental-use acknowledgement
  is also required. Partial/raw data remains exportable.

## Reporting and recovery

- New reports clear all old charts, diagnostics and export state. Changing the
  next target on the phone does not silently reinterpret the existing report.
- Versioned JSON save/import, per-patch phone persistence, display restore/clear
  controls and graceful handling of unavailable browser storage.
- Session identifiers also work when `crypto.randomUUID` is unavailable.
- Deterministic demo, permanently labelled in its exported session, with correction
  downloads blocked. A running measurement cannot be replaced by the demo.
- Responsive action groups and tables, progress/status accessibility, visible
  focus and keyboard-accessible alignment. External font dependency removed.

## Important interpretation changes

The former live white-balance tuning is now **relative grey balance**: common RGB
monitor gains cancel in the ratio and cannot establish D65/D50. Unsupported print,
D50 and Display P3 targets were removed. Temporal modulation is not labelled PWM
frequency detection. Camera colour-response indices are not measured Delta E or
gamut coverage. Very high/unresolved apparent contrast does not prove a numerical
lower bound. ICC primaries are explicitly assumed sRGB, not measured.

The landing page and README now distinguish these limitations from software
correctness. Previously implied physical accuracy is not claimed.

## Development and compatibility

Added dependency-free Node test/source-check commands, a loopback development
server, optional browser/parser harnesses and GitHub Actions for Node 20/22.
See TESTING.md for checks actually executed and remaining hardware coverage.

Deploy all updated HTML/CSS/JS files together. JSON uses the new version-1 session
schema; arbitrary old result objects are not accepted as session files. Both
devices need the same application version. No automatic profile installation or
automatic resumption of an interrupted camera run has been added.
