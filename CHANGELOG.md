# Changelog

## 2.1.0 - 2026-09-07

### Measurement failure and recovery

- Replace the old loose test loop with an owned lifecycle: begin, preflight,
  render, settle, sample, check, save, checkpoint, complete or recoverable pause.
- Transmit a visible failure state even if no readings were captured. An old idle
  message cannot erase active progress or hide an error.
- Bound render, camera, setup, storage and acknowledgement waits. Retry failed
  patches twice; Stop cancels outstanding operations. Heartbeat/status checks make
  lost peer/test updates visible instead of leaving Starting indefinitely.
- Keep the phone preview visible while users scroll to Run and progress. Camera
  acquisition checks inline/muted playback and fresh frames, with a guarded
  advancing-frame fallback when video callbacks stall.
- Preserve accepted readings before requesting the monitor's checkpoint acknowledgement.
  Save to both devices using IndexedDB with localStorage fallback. Reconnect/refresh
  recovery revalidates the saved reference and rejects incompatible plans.

### Agreed workflow

- Matching monitor/phone square with coloured corner markers, perspective mapping,
  guidance and fixed square sampling. Imperfect/undetected alignment does not lock
  out the Lock Sampling button; a manual lock is reported as unconfirmed.
- Exposure/clipping preflight, supported-control attempts and confirmed-only camera
  lock indicators. Clipping popup explains remedies without claiming distance
  reliably fixes exposure. Changed monitor settings require a fresh test.
- Best-effort visual movement pause plus an optional iPhone motion sensor.
  Resolution/orientation changes invalidate the sampling lock.
- Quick (20), Standard (54), Detailed (92) and Full (143) readings. Standard is
  preselected/recommended; each mode shows an estimate and adaptive remaining time.
- Beginner/Advanced interface, preset/technical target dropdown groups, simple
  status above lower technical details, and progress on both devices.
- Full report structure on both devices, explicit not-measured notes, measurement
  quality grading, conditional field-uniformity and temporal checks, safe guidance
  and gated ICC/CAL/JSON/CSV/log exports. Monitor report can be printed.
- Explicit iPhone Safari capture guidance and unsupported-browser notice.

### Deployment and tests

- Build/protocol matching and cache-versioned nested modules prevent silent mixed
  client deployments. Updated homepage and web-only upload guide.
- Add workflow/geometry/storage/motion tests and update DOM regressions to cover
  the reported zero-frame failure, recovery, clipping, manual lock, Stop and reconnect.
- Documentation distinguishes tested software from untested real-iPhone hardware
  behaviour and unproven measurement accuracy.

---

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
