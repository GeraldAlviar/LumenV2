# Lumen 2.1 validation

## Executed in this environment

- **93 Node automated tests passed**, including the 56 baseline tests and new workflow/alignment/recovery cases.
- **24 Chromium DOM integration checks passed**, using about:blank iframes with the production controllers and explicit camera, Peer transport and storage doubles.
- **3 ICC parser checks passed**: LittleCMS opened sRGB, Gamma 2.2 and Gamma 2.4 target fixtures and constructed RGB-to-sRGB transforms.
- JavaScript syntax, local HTML references and duplicate element IDs checked successfully.

These results are software evidence, not a claim that the updated app has completed a real iPhone measurement. Browser navigation was blocked by the execution environment. The DOM suite therefore does not exercise normal HTTP module loading, actual camera permissions, Safari, WebRTC signalling/NAT traversal or a physical monitor. The module-loader adaptation is test-only; production files remain ES modules.

No physical iPhone, calibrated reference instrument or operating-system profile installation was available. The original recordings guided the fix, but recordings cannot validate newly written code on their own.

## Regression coverage

Node tests include first-sample failure with zero readings, finite camera deadlines, stalled compositor callbacks with advancing media time, rejection of frozen frames, request/reply validation, two retries, cancellation, duplicate starts, each of the four complete mode plans, optional diagnostic skipping, immutable checkpoints, resume without duplicate readings, corrupt plan rejection, storage fallback/denial, settings drift, clipping, confirmed versus ignored camera locks, square geometry/detection, noisy movement rejection, significant movement and lost-marker handling, report omissions/XSS safety and correction gating.

The DOM suite checks four mode controls/defaults, target groups, Beginner/Advanced behaviour, pairing/version verification, real square geometry, automatic/visual alignment, exposure preflight, clipping popup, the zero-reading error appearing on BOTH screens, reconnect checkpoint retention, monitor-to-phone recovery availability, zero-reading partial reports, movement pauses, monitor pause cancellation, resume prerequisites, a complete simulated Quick run, progress agreement, JSON/CSV/HTML/ICC/CAL handlers, invalid JSON recovery, simulated-data restrictions, missing-lock export blocking and tested-width horizontal overflow. No uncaught JavaScript errors were observed in those scenarios.

`tests/browser_smoke.py` forwards to the same DOM suite. It is not an additional test count. ICC parser checks are also not GPU calibration loading tests. Timings from simulated runs are not the UI's real-device duration estimates.

## Commands

```sh
npm run check
npm test
```

Optional tools, with Python dependencies already installed:

```sh
python tests/dom_smoke.py
python tests/icc_smoke.py
```

Set `CHROMIUM_PATH` when Chromium is not at `/usr/bin/chromium`. The DOM suite needs the Python Playwright package. The ICC suite needs Pillow built with LittleCMS. No real camera permission or external request is used by these test suites.

Generated diagnostics go in `test-results/`, which is excluded from the delivery ZIP and Git tracking. The suite can produce synthetic screenshots and fixtures there. They are not hardware evidence.

## Required iPhone Safari acceptance checks

Record the iPhone model, iOS version, Safari version, monitor model, desktop browser and whether both pages display v2.1.0. This remains to be done on real hardware:

1. Pair by QR/link and by code, then test unavailable CDN/signalling and a deliberately wrong code. A visible error must appear; no infinite Connecting.
2. Start camera with permission allowed, denied and granted after a denial. Verify the actual rear-camera image and both overlay regions align without stretch/crop errors in portrait and landscape.
3. Match the square, verify guidance, deliberately use imperfect alignment and explicitly accept visual alignment. Lock must not require perfection; manual mode must disclose unavailable movement detection.
4. Test white clipping, reflections and unsupported/ignored camera controls. Confirm Run stays blocked while clipped, the popup explains recovery, and unconfirmed locks are not labelled successful.
5. Complete **Quick Check first**. Verify 20 steps, changing monitor patches, stage updates and time estimates on both devices. Confirm the square remains visible and the first measurement either arrives or produces a bounded paused/error state.
6. Scroll the phone preview out of its original location during a run. The compact live preview should remain visible. Confirm frozen frames cannot be counted as fresh samples. Record whether media-clock fallback is invoked.
7. Test phone Pause/Stop, monitor Pause/Stop and Escape. Double-tapping Run must not create two runs. Hide either tab, lock the iPhone or end the camera stream; the run must pause and preserve completed data.
8. Move/rotate the phone deliberately. Confirm pause without excessively reacting to minor jitter. Cover a corner marker. Recover using realignment and reference rechecks. Confirm manual alignment does not pretend to detect movement.
9. Disconnect the network/peer during rendering, sampling and checkpoint acknowledgement. Reconnect and resume without duplicated readings. Try phone reload, monitor reload, both reloads and restoring the monitor copy. Test storage denied/private browsing as well as normal IndexedDB.
10. Change brightness/gamma midway through a paused test. The unchanged-settings acknowledgement must not be used to conceal a real change. Reject incompatible reference rechecks and start a new test. Test stale/corrupt JSON and mixed app versions.
11. Complete Standard (50 steps), Detailed (83) and Full (140). Validate optional temporal/uniformity results or explicit Not measured reasons. Time these runs to refine initial estimates.
12. Export/import JSON, download CSV/HTML, print the report and check correction gates on actual Safari metadata. Test current-profile backup and ICC/CAL loader compatibility separately before any OS installation.
13. Compare repeated runs and any derived corrections against a suitable calibrated instrument. Investigate lens shading, local tone mapping, display automatic brightness limiting, browser colour management and viewing angle. Without this, do not advertise accuracy bounds or professional calibration.

## Suggested release gate

At minimum: a real successful Quick and Standard run; first-reading failure and clipping feedback; movement and manual pause recovery; reload checkpoint recovery; an honest unsupported-lock warning; and verified exclusion of invalid correction exports. Keep the release described as experimental until reference-instrument validation exists.
