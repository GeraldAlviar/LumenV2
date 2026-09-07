# Lumen 2.2.0

An experimental, static, two-device monitor assessment: a browser displays patches and an iPhone running Safari samples the screen through its camera. This release prioritises getting a usable diagnostic report without demanding perfect alignment.

**Not a substitute for a calibrated colorimeter.** Lumen does not measure reliable absolute nits, D65/D50, Delta E, or gamut coverage. It does not automatically change monitor settings or install profiles. The camera, lens, room lighting, viewing angle, Safari processing and display pipeline all affect the result.

## What changed

- **Lock sample positions is immediate.** It saves geometry and enables Run; exposure/stability checks are no longer a prerequisite for locking.
- **Approximate positioning is enough to start.** Automatic detection uses the square's actual position, scale and perspective, not its overlap with the guide. A valid manually selected quadrilateral is also accepted.
- **Mark four corners** supplies a fallback when automatic detection fails. Tap top-left (magenta marker), top-right, bottom-right, bottom-left. Undo is available. Without detection or manual points, the approximate guide can still be locked.
- **Recoverable warnings have Continue anyway.** The choice persists for that test and is saved with the report. Such a session is diagnostic-only; raw exports remain available, but ICC/CAL corrections are disabled.
- **No generic capture gate.** Warnings name unsettled frames, noise, modest clipping, changed references or sample-position problems. No camera frames, malformed readings, an unusably dark reference or severe clipping still stop capture.
- **Movement checks have tolerance and persistence.** Brief marker loss and small shifts do not immediately pause. Unreliable tracking can be explicitly disabled; the recorded quality notes explain the limitation.
- **Repeated references** check drift throughout every mode. Lumen does not silently compensate for changing exposure/white balance.
- **Fresh before/after verification** compares separately measured, held-out grey tones with a saved baseline. The original full report is saved separately when storage is available. This is camera-relative verification, not proof of successful physical calibration or profile installation.
- **Optional monitor preparation** asks which controls exist and displays a light/dark step pattern. “Close enough / back to alignment” is always available.
- **Release integrity check** verifies the 29 runtime files against SHA-256 entries in `release-manifest.json`. Missing or stale files are named before the controllers start. A static version label alone is no longer the success signal.

## Use it

Open the HTTPS GitHub Pages site on the monitor and choose Monitor. Pair the iPhone Safari page using its code or QR. Start the camera, select a target and test depth, then rest the phone on a support.

Position the square approximately. Let detection find it, or select **Mark four corners** and tap the four markers clockwise from the magenta corner. Check that the two small sampling squares sit inside the corresponding monitor patches. Press **Lock sample positions**, then **Run**.

For a recoverable camera warning, choose **Retry this check**, **Continue anyway / diagnostic report**, or **Stop and keep readings**. A diagnostic report still requires real, finite camera readings. It never synthesises missing samples.

Keep both tabs visible and do not move the phone while measuring. Progress, pauses and review states appear on both screens. Two automatic retries precede a pause or a recoverable warning choice. Camera/network waits and the five-minute user-choice window are bounded.

### Test depths

| Mode | Initial estimate | Main-sequence readings | Additional checks |
|---|---|---:|---|
| Quick Check | About 45 seconds | 27 | Basic tonal response |
| Standard, recommended | About 2-3 minutes | 65 | Colour-response probes |
| Detailed | About 4-5 minutes | 107 | Repeats; conditional 3 x 3 visible-field uniformity |
| Full | About 7-10 minutes | 163 | More repeats; conditional 5 x 5 uniformity and temporal variation |

Every mode includes repeated reference captures and four held-out tones not used in the grey fit/correction LUT. A separate fresh verification uses **18 readings**, initially estimated at **45-75 seconds**. Setup, pauses, retries and user decisions can extend these times. These estimates are not benchmarks from a real iPhone; the remaining-time estimate updates during a run.

Quick does not include a colour sweep or uniformity. Unmeasured sections stay visible with explanations. Uniformity is conditional on seeing the field corners without moving the phone; it includes lens shading and viewing-angle effects. Temporal variation is not a measurement of PWM frequency.

## Camera-quality policy

Recoverable conditions include unsettled ratios, moderate noise, a small clipped fraction, weak but present reference signal, unconfirmed camera controls, and reference drift. Some are informational; others request an explicit diagnostic override. Camera lock availability is reported from confirmed settings, not assumed from an API call.

Diagnostic consent applies only to recoverable capture warnings in the current session. Every later reading is still checked for unusable signal and severe clipping. Starting a new test clears the previous session's consent. Resuming an accepted diagnostic session retains it.

Software thresholds are heuristics, not instrument certifications: capture clipping over 2% is a warning and 50% or more is a blocker; repeated-reference ratio drift over 8% requests review. See `js/capture.js`, `js/tracking.js` and the tests for the complete policies.

**Do not change monitor brightness mid-test to remove clipping and then merge the readings.** Retry camera exposure if supported, check sample locations/reflections, or start a fresh test after changing monitor settings. Simply moving farther away is not a reliable exposure fix.

## Before/after verification

After a completed test, choose whether you changed monitor settings, applied a profile outside Lumen, or changed nothing for a repeatability check. Add a note and select **Verify with fresh measurements**. Reposition/lock and start the new run.

The fresh tones use a new session ID and a separate plan. Results report camera-relative mean absolute tonal error in percentage points, not Delta E. Low-confidence comparisons explicitly warn against treating a numerical change as proof of improvement. The browser cannot confirm an operating-system profile was installed. Changing targets makes comparisons invalid.

## Results and exports

Both devices show quality and full measurement coverage. The monitor provides charts, recommendations, raw CSV/JSON, an HTML report and printing. The phone provides raw CSV, session JSON, diagnostic logs, comparison and experimental correction exports where eligible.

ICC/CAL exports require complete sufficient readings, conservative quality checks, confirmed exposure **and** white-balance locks, no diagnostic override, and acknowledgement. A verification-only run, simulated data, missing references or poor-quality capture cannot generate a correction. The ICC assumes sRGB primaries; Lumen did not measure them. Available downloads do not establish physical accuracy.

## Recovery and privacy

Numerical checkpoints are saved locally on both devices using IndexedDB with a localStorage fallback. Browser storage can fail or be evicted; JSON is the portable backup. This is not cookie-based recovery or a server account. Reconnection/reload requires a fresh lock and reference recheck before resuming. Old plan-version-1 reports can be read, but cannot resume in plan version 2.

Camera frames are processed on the phone and are neither sent to the paired monitor nor stored by Lumen. Numerical readings and control messages cross the PeerJS connection. Pairing uses an external signalling service. The pinned PeerJS 1.5.4 and optional QRious 4.0.2 scripts still load from public CDNs; network/content-blocking failures are now explained. This is not an offline or zero-network application.

## Uploading

See **UPLOAD-GUIDE.md**. The ZIP contains the complete project at its root, with `index.html`, `phone.html`, `desktop.html`, `css/`, `js/` and `release-manifest.json` together. No user-side build or source editing is required. Upload complete folders, not just individual controllers. Keep GitHub Pages on the existing branch/root configuration.

Success is **v2.2.0 / files verified** on both devices. The file check deliberately refuses mixed source releases. It is an accidental-deployment check, not a cryptographic signature or protection against a server that changes both source and manifest.

## Development and tests

Requires Node 20 or later for local scripts. No npm packages are required.

```sh
npm run serve
npm run check
npm test
npm run verify-release
```

The local server binds to `127.0.0.1:8080`. A real phone needs the HTTPS-hosted site, not a loopback address or a downloaded HTML file. Optional Python browser/ICC checks are described in **TESTING.md**.

After editing runtime files, maintainers must run `npm run release` and ship the updated manifest together with the source. The supplied ZIP already contains it. Bump every build/module query version for a new release; do not reuse a published build number for changed runtime content.

See **INSPIRATION.md** for the external workflow references and what Lumen does not borrow or claim. See **TESTING.md** for the exact validation scope and outstanding real-iPhone checks.
