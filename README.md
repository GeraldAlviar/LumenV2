# Lumen

Experimental monitor checks using a phone camera. The display presents test and
reference patches; the phone samples both and sends numerical readings to a
report. There is no account, app installation, build step or application backend.
Pairing still relies on external infrastructure.

**This is not a substitute for a calibrated colorimeter or spectroradiometer.**
Software stability checks do not establish physical measurement accuracy. No
absolute white point, luminance, gamut coverage or certified colour accuracy is
reported. ICC and CAL corrections are explicitly experimental.

## What changed in this version

Measurements have real deadlines and can be cancelled during rendering, settling
or sampling. A dropped connection cancels pending work instead of leaving the
phone waiting. Only one camera operation can run at a time. Camera locks are
reported only when the browser confirms them, and preview circles correspond to
the actual sampling discs.

Reference selection, missing-reference handling, stray-light fitting, black-level
normalisation and monotonic correction curves have been corrected. The report
flags incomplete or poor-quality data and blocks correction downloads until a
complete greyscale passes the software gates and the limitations are acknowledged.

Raw JSON sessions can be saved, reopened and restored from browser storage. A
labelled demo works without a camera; its correction downloads are disabled.
See [CHANGELOG.md](CHANGELOG.md) and [TESTING.md](TESTING.md).

## Run locally

For the demo, report, imports and desktop development, use Node.js 20 or newer:

```sh
npm run serve
```

Open `http://127.0.0.1:8080/`. There are no npm dependencies to install. Choose
**Explore a simulated report first** to use the interface without a paired phone.
The server binds to loopback only and is for development, not production hosting.

On macOS/Linux, an alternate port is `PORT=8765 npm run serve`. In PowerShell use
`$env:PORT=8765; npm run serve`.

**A real phone needs the app on an HTTPS origin.** The computer's `localhost` is
not the phone's `localhost`; copying that URL to the phone will not connect it to
the computer. Do not open the HTML directly as `file://`.

## Deploy

Publish `index.html`, `desktop.html`, `phone.html`, `css/` and `js/` together to an
HTTPS static host. No build output or secret keys are required. For a GitHub Pages
repository deployment, keep this directory structure at the published root and
publish that branch/folder. Relative paths support a repository subdirectory.

Both devices must load this same version. Replace the full `js/` directory, not
just the controller files: the new validation, quality, session and cancellation
modules are required. If a host caches assets, refresh both devices after updating.

PeerJS 1.5.4 and QRious 4.0.2 are pinned in the HTML. If the QR library fails, the
manual code and pairing link remain available. If PeerJS or its signalling service
is unavailable, use the actionable retry controls; demo and local session analysis
remain usable without a connection. Hosting the library scripts yourself does not
remove the need for signalling/STUN infrastructure.

## Measurement workflow

1. Open **Monitor** on the display under test. Keep its settings fixed. Disable
   HDR, dynamic contrast, adaptive brightness and automatic colour-temperature
   changes. Reduce reflections and avoid changing ambient lighting.
2. Open **Phone** using the QR code or pairing link, or type the five-character
   room code. Only one phone is accepted by a display session at a time.
3. Start the camera and rest the phone on a stable support. Drag the dashed
   reference circle into the left patch and the solid test circle into the right
   patch. Keep both sampling discs away from edges, glare and labels. The sample
   size slider changes the actual sampling region. Arrow keys also move handles.
4. Let the preview settle. **Try locking current camera settings** attempts to
   preserve the current exposure, focus and white balance only where supported.
   The app distinguishes confirmed locks from unavailable or ignored requests.
5. Choose a transfer curve and run. Keep both tabs visible. A failed quality check
   is retried once; persistent problems remain visibly flagged, not silently
   discarded. A sample collection failure stops the run and retains completed
   readings. The report explains why correction export is blocked.
6. Review the report on the monitor. Save JSON for recovery and reanalysis; CSV is
   useful for inspecting raw ratios, clipping, stability and noise.

**Stop current test**, Escape, stopping the camera, hiding a measurement page or
losing the connection interrupts active work. Partial readings are retained, but
interrupted runs are not automatically resumed. Reconnect and start a fresh run
after correcting the problem.

### Run types

| Run | Patches | Contents |
| --- | ---: | --- |
| Quick greyscale | 20 | 4 ladder references, 5 stray-light readings, 11 greys |
| Greyscale only | 30 | 4 ladder references, 5 stray-light readings, 21 greys |
| Full experimental check | 61 | Full greyscale plus 24 colour and 7 additional probes |
| Camera colour response | 40 | References and colour probes; no correction export |

Duration depends on camera frame delivery, settling and retries; a patch count is
shown instead of an assumed completion time.

The supported targets are the **sRGB transfer curve**, **Gamma 2.2**, and **Gamma
2.4 (zero-black BT.1886)**. These are tone-response targets, not gamut or white-point
calibrations. The former D50/print and Display P3 presets have been removed because
the rendering and measurement path cannot establish those properties.

### Separate diagnostics

**Live relative grey balance** compares 80% and 50% grey. It shows channel drift
between those levels, not absolute white balance. A uniform per-channel monitor
gain cancels from both patches under the ratio model, so the readout cannot guide
D65/D50 RGB-gain tuning. No absolute gain adjustment is prescribed.

**Uniformity** first shows a mid-grey field. Position the phone square-on and drag
the rectangle to the illuminated field, then press **Capture uniformity**. The
result is a 5 by 5 grid within those bounds. This rectangle is not a perspective
correction; lens shading, viewing angle and reflections remain confounders.

**Temporal modulation** reports variation observed in camera frames. It is not a
PWM detector or frequency measurement. Limited frame rate, rolling shutter,
exposure integration and automatic camera processing can hide or create apparent
variation. A quiet result does not establish that the monitor is flicker-free.

## Sessions and privacy

Frames stay on the phone. Numerical samples and control messages travel over the
paired data channel. PeerJS/QR scripts load from public CDNs, and the public PeerJS
signalling service and WebRTC connectivity services exchange connection metadata.
This is not a zero-network or guaranteed-offline application. The short room code
is a convenient pairing mechanism, not strong identity authentication; do not use
it as a security boundary or share it publicly.

When storage is available, the phone saves after each completed patch and the
display saves received results. The display's **Restore last session** and **Clear
saved data** operate on its own origin/browser storage. Clearing that copy does
not delete the phone's copy or downloaded files. Clear the phone's site data in
its browser to remove that copy. Browser storage can be evicted, so use **Save
session JSON** for an intentional backup. Live camera sessions do not resume
across reloads; raw data can be reopened on the monitor page.

The JSON format has a version, creation time, target, raw readings, diagnostics,
completion status and simulation flag. Imports are limited to 2 MB and 512
readings, validated before use, and recomputed rather than trusting saved charts.
This is structural validation, not proof that a file is authentic measurement data.

## Measurement model and limitations

A shared *multiplicative* camera gain can cancel when two regions in the same
frame are divided. Nonlinear processing, local tone mapping, black offsets,
spectral mixing and clipping do not generally cancel. Inverse sRGB decoding is
an explicit approximation to the camera pipeline, not a verified linearisation.

Adjacent reference measurements form a brightness ladder. Missing ladder steps
are an error, not a reason to invent a nominal display response. Black readings
beside several references support an approximate stray-light slope fitted
against reconstructed **linear** anchor brightness. Ambient light, camera black
and true display black are not independently identified.

The gamma fit normalises its endpoints for the estimated black level. Correction
curves use monotonic regression in signal order before inversion. These numerical
improvements do not remove systematic camera error. Apparent contrast is labelled
an estimate; very high or unresolvable values do not prove a lower bound on the
monitor's true contrast. Colour-response indices are not measured Delta E or gamut
coverage. Browser colour management and existing GPU/OS calibration affect the
entire tested pipeline; the app cannot isolate the panel from that pipeline.

Software export gates require complete, uniquely referenced greyscale readings,
black/full-white endpoints, sufficient distinct grey levels, adequate sample
counts, convergence and limits on clipping, noise and channel variation. These
are conservative software checks, **not instrument validation**.

## Exports

**JSON** contains the portable session. **CSV** contains raw measurements and any
available grey analysis. Labels are escaped and protected against spreadsheet
formula interpretation. Both remain available for partial or questionable data.

**ICC** contains experimental calibration curves in a `vcgt` tag and an **assumed
sRGB-primary** matrix. The sRGB tone curve uses a sampled piecewise transfer
function, not a gamma-2.2 substitute. The matrix is not a measured description of
your monitor: do not use it as a wide-gamut, HDR or print-proof profile.

**ArgyllCMS CAL** contains experimental per-channel calibration curves, not a
characterisation of the display primaries. ICC/CAL downloads require a suitable
complete session and an explicit acknowledgement. Demo data cannot enable them.

The app does not install or apply profiles. A compatible OS/calibration loader
must apply the curves, and support varies. Save the previous profile and settings
before experimenting; restore them if the result is worse. Do not stack repeated
corrections, assume the file proves calibration, or replace a professional profile
without independent verification.

## Development

```sh
npm test
npm run check
```

Unit tests cover numerical recovery, invalid data, correction tables, session
handling, camera deadlines/cancellation and connection lifecycle. `npm run check`
checks JavaScript syntax, HTML IDs and local references. The optional Python
Playwright scripts are described in [TESTING.md](TESTING.md); Playwright is not a
runtime dependency. GitHub Actions runs the dependency-free checks on Node 20/22.

```
index.html       landing page and method
phone.html       pairing, camera and run controls
desktop.html     patch display, report, imports and exports
css/app.css      responsive UI
js/async.js      abortable waits
js/net.js        pairing, protocol validation and bounded requests
js/sensor.js     camera acquisition, sampling and diagnostics
js/patches.js    supported targets and complete reference sequences
js/analysis.js   ladder, stray-light model, tone fit and correction curves
js/colour.js     colour calculations and transfer functions
js/quality.js    software data-quality gates
js/validation.js bounded message/session validation
js/session.js    versioned raw sessions and browser storage
js/demo.js       deterministic, explicitly simulated readings
js/phone.js      single-operation controller and cancellation
js/desktop.js    rendering, analysis, report state and exports
js/icc.js        ICC, CAL and CSV writers
scripts/         local server and source checks
tests/           automated regressions and optional browser harnesses
```

### Primary implementation references

- PeerJS connection and lifecycle APIs: https://peerjs.com/docs/
- Camera access and secure contexts: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- Camera constraints: https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/applyConstraints
- Video frame callbacks: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
- QRious: https://github.com/airmrcr/qrious

## Licence

The supplied project's licence statement was: "Do what you like with it."
This update does not replace that statement with a different licence.
