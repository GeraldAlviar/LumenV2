# Lumen 2.1 validation record

## Executed checks

| Check | Result | Scope |
| --- | --- | --- |
| `npm test` | 81 passed, 0 failed | Original numerical/network/sensor regressions plus new workflow, retry, recovery, square-geometry and motion tests |
| `npm run check` | Passed | JavaScript syntax; duplicate HTML IDs and local HTML asset references |
| `python tests/dom_smoke.py` | 16 passed, no uncaught page errors | Actual HTML/CSS/controllers, simulated acquisition and in-memory paired transport |
| `python tests/icc_smoke.py` | 3 passed | LittleCMS opens all three target profiles and constructs RGB transforms |

Software checks do **not** establish real iPhone camera behaviour, physical accuracy,
WebRTC network traversal, GitHub deployment success or operating-system LUT loading.
The included GitHub Actions workflow has not been run remotely by this update.

## Reproducing the reported failure

The DOM test starts a real production runner and removes the synthetic camera
frames at the first patch. It verifies zero accepted readings, two retries, a paused
state on both devices, a visible corrective dialog, and a monitor square that does
not disappear. Realignment and Resume subsequently complete the 20-reading Quick
plan. Separate checks cover clipping, a manual lock with undetected markers,
Stop/duplicate-run prevention, disconnect checkpoints and reconnection/revalidation.

The previous phone error path could send `idle` after a zero-reading failure without
sending the reason to the monitor. That explains how patches could disappear while
its progress retained Starting. This is a verified code-path defect. The physical
cause of missing frames on the recorded iPhone is **not confirmed** by these tests.
A preview scrolling out of view is a plausible contributor, not a proven diagnosis.

## Unit coverage added in 2.1

The new workflow tests exercise complete runs; missing start acknowledgements;
zero-frame and permanently stalled acquisitions; bounded retry; clipped sample
rejection; duplicate-start prevention; cancellation; preserving a reading after a
lost checkpoint acknowledgement; resuming at the first missing patch; rejecting
changed plans; handling a lost final acknowledgement; diagnostic omissions;
detached snapshots; versioned JSON; unavailable storage; deadline abortion;
portrait/landscape square geometry; perspective projection; marker detection;
manual guidance; sustained motion events and denied motion permission; truthful
quality grading; and validation of rendering messages.

## Browser environment limitation

Normal Chromium navigation to the local server was attempted and blocked by
`ERR_BLOCKED_BY_ADMINISTRATOR`. Environment policies were not modified. The DOM
harness therefore loads local HTML/CSS into in-memory about:blank frames and wraps
the same source modules for evaluation. Camera acquisition and transport are test
doubles. Sample collection, clipping/convergence checks, measurement orchestration,
render acknowledgements, reports and controls use production code.

This does not test network module fetching, actual camera permissions, the public
signalling/CDN services or actual iOS WebKit. The phone screenshot uses a synthetic
capture canvas; it is not a photo of a physical monitor or an iPhone test result.

To run the harness in a suitable environment:

```sh
python -m pip install playwright
python tests/dom_smoke.py
```

Set `CHROMIUM_PATH` to an installed Chromium executable if it differs from
`/usr/bin/chromium`. The harness does not need a local server. It writes screenshots
and a machine-readable check list to ignored `test-results/`.
`tests/browser_smoke.py` is a compatibility entrypoint to this same harness, not a
separate passed integration suite.

For independent ICC parsing, install Pillow with LittleCMS support and run:

```sh
python tests/icc_smoke.py
```

## Required real-device acceptance test

1. Deploy the complete web update and reopen both pages. Confirm **v2.1.0** on
   monitor and iPhone Safari. Confirm the fresh build loads with no missing modules.
2. Start with Quick Check and unchanged SDR monitor settings. Pair, allow the camera,
   align the square and lock sampling. Check the camera remains visible while
   scrolling to Run. Confirm clipping blocks readiness with an understandable message.
3. Run. Verify Preparing/Settling/Sampling/Checking/Saving and the same progress on
   both devices. Verify the square remains fixed and the test reaches its first
   accepted reading and then a report. Record elapsed time; estimates are not yet
   benchmarked on a physical iPhone.
4. Repeat with a deliberately moved phone. Check automatic pause where tracking is
   available, then realign, lock and resume. Try with motion permission allowed and
   denied. Do not assume slow movement will always be detected.
5. Test manual pause, Stop, the monitor's Escape control, phone/monitor backgrounding,
   screen lock, camera stop, orientation change and network disconnection. There
   must be an actionable message, not a silent Starting screen.
6. Reload the phone and reconnect. Restore local progress or use the monitor backup.
   Verify it rechecks the reference and resumes at the first missing reading. Change
   monitor settings and verify a new test is required rather than mixing results.
7. Test Standard, Detailed and Full on a supported stand. Check omitted/unavailable
   diagnostics are labelled, including field corners that cannot be seen. Compare
   timing and false movement/clipping warnings across iPhone models/iOS versions.
8. Save JSON/CSV/logs. Verify reports agree across devices and that incomplete,
   simulated or poor data cannot export a correction. Test ICC/CAL loading and
   rollback separately; this build does not install a profile.

Physical accuracy, repeatability against a calibrated instrument, camera response,
lens shading, viewing-angle effects, rolling shutter, aliases, HDR processing and
GPU/OS calibration loading remain unvalidated. Passing software tests is not a
substitute for these checks.
