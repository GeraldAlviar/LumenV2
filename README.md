# Lumen 2.1.0

Experimental SDR monitor checks using **iPhone Safari** as the camera. The monitor
shows a fixed square with two measurement patches; the phone samples their locked
positions. Both devices show progress, errors and recovery instructions.

**This is not instrument-grade calibration.** Phone-camera processing is not a
calibrated photometric or colourimetric measurement. The app does not measure
absolute luminance, white point, Delta E or gamut coverage. ICC/CAL output is an
explicitly experimental correction using assumed primaries, not a measured display
profile. A quality rating describes the captured data, not proven physical accuracy.

## Updating an existing GitHub Pages site

Upload these together at the repository root, preserving the folder structure:

```
index.html
desktop.html
phone.html
css/
js/
```

Upload the **contents** of the extracted website-update ZIP, not the ZIP or an
extra enclosing directory. Existing files with these paths should be replaced;
the new JavaScript modules must also be added. Keep your current repository and
Pages branch/root settings. No source-file edits or npm installation are needed.

After the deployment finishes, reopen or refresh **both** devices. The monitor and
phone must show **v2.1.0**. Do not combine this update with the earlier V2 ZIP. The
entrypoints and nested module imports carry a build query and the peers compare
their build/protocol before measurement. This reduces, but does not eliminate,
the need to refresh old browser tabs after an upload.

The complete-source ZIP additionally contains tests, developer scripts and these
documents. They are not needed to serve the website. See `UPLOAD-GUIDE.md`.

## New workflow

1. Open Monitor on the display to be checked. Use fullscreen **before** alignment.
   Keep SDR monitor settings and room lighting fixed. Disable automatic picture
   adjustments and reduce reflections.
2. Connect the iPhone in Safari with the QR code, link or five-character room code.
   Choose Beginner/Advanced, a preset or technical target, and a test depth.
3. Start the camera. Rest the phone on a stand and match the square on the monitor
   to the square in the preview. Automatic marker detection helps with scale,
   position and tilt, but a perfect match is not mandatory.
4. Tap **Lock sampling**. With unconfirmed markers, the visible guide can be locked
   manually; the report records this limitation. Sampling coordinates do not move
   to chase patches. Keep the phone still after locking.
5. The app checks full-white clipping, attempts supported camera controls, checks
   the actual returned settings, and samples a reference pair. **Run** is enabled
   only after these checks pass. A clipping/error dialog explains how to recover.
6. Run the test. Each patch has a render acknowledgement, settling, acquisition,
   validation, local save and monitor checkpoint. Progress appears on both devices.
7. Significant detected movement, hidden tabs, camera stoppage or communication
   failure pauses the test. Realign, lock sampling again and **Resume**. Completed
   readings remain stored. If the saved reference differs too much, start a new
   test instead of combining incompatible readings.
8. Review results and measurement quality on either device. The whole report is
   shown, with explicit **Not measured in [test name]** notes for omitted sections.
   JSON, CSV, diagnostic logs, experimental ICC/CAL and monitor printing are available
   where applicable. ICC/CAL are disabled for insufficient, poor or simulated data.

## Test depths

| Mode | Planned readings | Estimated measuring time | Coverage |
| --- | ---: | --- | --- |
| Quick Check | 20 | ~45 seconds | Reference/stray-light checks and 11 grey levels |
| Standard Test (default) | 54 | ~2-3 minutes | References, 21 grey levels and 24 colour-response patches |
| Detailed Test | 92 | ~4-5 minutes | 41 grey levels, colour probes, repeats; conditional 3 x 3 field check |
| Full Test | 143 | ~7-10 minutes | 61 grey levels, more repeats; conditional 5 x 5 field and temporal checks |

These are design estimates, not measured iPhone benchmarks. Camera setup is
additional. Retries and pauses can take longer; the remaining-time display adapts
to observed patch durations. More patches do not establish colourimetric accuracy.
Full is deliberately called a *test*, not certified full calibration.

Simple presets and technical targets are separate dropdown groups. General/Gaming
map to gamma 2.2, Photo/web to the sRGB tone curve, and SDR Video to zero-black gamma
2.4. They do not establish an absolute white point or a nonzero-black BT.1886 fit.

## Exposure, clipping and movement

Manual exposure, white balance and focus are attempted only if reported as
supported; success is confirmed through `getSettings()`. Unconfirmed locks remain
labelled automatic and reduce the quality rating. No unsupported camera control is
presented as a successful lock. The app cannot guarantee that Safari will expose
manual camera controls on a particular iPhone.

If clipping persists, check patch alignment and glare, then retry camera setup.
Moving farther away is not a reliable solution to overexposure. Changing monitor
brightness or picture mode requires a **new** measurement; do not resume a run
that was captured under different monitor settings.

The square's markers support visual movement checks. Optional iPhone motion
permission is available in Camera & connection details. Denial does not block
measurement. Both methods are best-effort and can miss subtle/slow movement or be
affected by reflections and marker visibility. Use a stand; neither is a guarantee.

## Recovery and privacy

Checkpoints are saved after each accepted patch to device-local IndexedDB, with a
localStorage fallback and a synchronous last snapshot. Preferences use
localStorage. **No cookies or account are used for recovery.** Both devices keep
separate copies when storage is available. Storage failures are reported without
discarding the current in-memory report. Browser eviction/private-mode behaviour
can prevent persistence; export JSON for an independent backup.

Recovery rechecks alignment and a saved reference. Old V1/V2 JSON reports can still
be opened, but only matching versioned 2.1 test plans can be resumed. Reloaded pages
do not retain camera permission, an active stream or the old peer connection;
reconnect and start the camera again. Recover from monitor backup is available
when the phone's local snapshot is missing.

Camera frames are processed only on the phone. Only numerical readings and control
messages travel to the monitor. Diagnostic downloads omit persistent camera device
and group identifiers. The app loads pinned PeerJS/QRious scripts from CDNs and
uses public signalling/STUN infrastructure; it is not offline or zero-network.
Keep pairing codes private and share them only with the intended phone.

## Additional checks and exports

Uniformity runs only if all four corners of a larger display field are visible and
steady without moving the phone. Otherwise its report states why it was not measured.
It covers the visible field, excluding the status strip; lens shading, view angle,
reflections and camera processing remain included. It is not a calibrated whole-panel
backlight map. Temporal results describe sampled camera-frame variation, not PWM
frequency and not proof of flicker-free operation.

Relative channel drift is not absolute white-balance tuning. The app intentionally
does not invent RGB-gain steps or a cd/m2 brightness recommendation. Experimental
ICC output assumes sRGB primaries and supplies correction curves; the app neither
installs nor applies a profile. Save the current profile before experimenting.

## Development and verification

No npm dependencies are needed. Node 20+ is used for developer commands:

```sh
npm run serve
npm run check
npm test
```

The development server is `http://127.0.0.1:8080`, bound to loopback. A real phone
needs the published **HTTPS** site; the computer's localhost is not the phone's
localhost. Do not open the files as `file://`.

`TESTING.md` records exactly which checks ran, what is simulated, and the real-iPhone
acceptance checklist. There is **no completed real iPhone Safari hardware test** for
this build in the development environment. Keep the previous version available
for rollback while evaluating this update.

Implementation references: [Apple video guidance](https://developer.apple.com/documentation/webkit/delivering-video-content-for-safari),
[WebKit video policies](https://webkit.org/blog/6784/new-video-policies-for-ios/),
[W3C MediaStream Image Capture](https://www.w3.org/TR/image-capture/), and
[GitHub web uploads](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository).
