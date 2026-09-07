# Validation report

## Checks executed for this revision

| Check | Result | What it establishes |
| --- | --- | --- |
| `npm test` on Node 22.16.0 | 56 passed, 0 failed | Numerical regressions, schema/quality gates, exports, storage, mocked sensor and link lifecycles |
| `npm run check` | Passed | Syntax of 20 JavaScript files; no duplicate HTML IDs or missing local HTML asset references |
| `python tests/dom_smoke.py` | 16 passed, no uncaught page errors | Browser DOM/controller workflows using explicit test doubles |
| `python tests/icc_smoke.py` | 3 target profiles accepted | LittleCMS opened each exported ICC and constructed an RGB-to-sRGB transform |

These are software checks with synthetic inputs. They do not validate phone
photometry, real network traversal, colour accuracy or operating-system calibration
loading. The Node 20/22 GitHub Actions workflow was added but has not run remotely.

## Unit coverage

The suite checks transfer-function round trips, a published CIEDE2000 reference
pair, reference selection and complete sequences, missing/duplicate references,
linear-domain stray-light fitting, required greyscale endpoints, black-normalised
gamma recovery, monotonic regression and correction-table limits.

Export checks cover ICC headers/tag offsets/calibration tables, the sampled sRGB
tone curve, CAL interpolation and CSV escaping/formula protection. Session checks
cover schema/version/size limits, malformed data, restricted storage and session-ID
compatibility. Test doubles check no-frame and stalled-frame deadlines, settling
cancellation, exclusive sample collection, truthful camera locks, uniformity
bounds, peer lifecycle, stale replies and rejection of pending requests.

Run these without package installation:

```sh
npm test
npm run check
```

## Browser DOM checks

The available managed Chromium blocks URL navigation and real camera acquisition.
A normal local-server browser run was attempted but stopped with
`ERR_BLOCKED_BY_ADMINISTRATOR`. Those environment policies were not modified.

The completed `dom_smoke.py` harness instead loads the actual local HTML/CSS into
in-memory frames and evaluates a test-only wrapper around the actual source
modules. It supplies in-memory storage, simulated camera acquisition and a paired
transport. It therefore exercises controller logic and DOM state, but **not**
browser ES-module fetching, external CDNs, actual camera permissions or WebRTC.

The 16 checks exercise demo labelling, export acknowledgement and download blobs,
clearing stale charts, invalid/valid JSON imports, restore/clear controls, pairing,
camera-ready reticle geometry, mode exclusivity, cancellation, a complete simulated
run through render acknowledgements, uniformity alignment/cancellation,
disconnect recovery and a 390-pixel phone layout.

Optional setup in an environment that permits it:

```sh
python -m pip install playwright
python -m playwright install chromium
```

Set `CHROMIUM_PATH` to an installed Chromium executable, then:

```sh
python tests/dom_smoke.py
```

The default path is `/usr/bin/chromium`. This harness requires no local server.
Its screenshots and JSON results go into ignored `test-results/`.

`tests/browser_smoke.py` is an additional full-navigation harness intended for an
unrestricted local environment. Start `npm run serve`, set `LUMEN_TEST_URL` for a
non-default port, and run it with Python Playwright. It uses fake camera frames
and a mocked transport, not real photometry or peer connectivity. It is included
for further testing; it did **not** complete in the environment used for this
revision. It must not be counted among the passed checks above.

## Independent ICC parsing

With Pillow built with LittleCMS support:

```sh
python -m pip install pillow
python tests/icc_smoke.py
```

The script generates profiles from synthetic readings for sRGB, gamma 2.2 and
zero-black gamma 2.4, opens them through LittleCMS and constructs colour
transforms. It does not install anything. Parsing a `vcgt`-containing ICC is not
proof that a particular OS or driver will load its calibration curves.

## Still needed before a production release

- Real iOS/Safari and Android camera permission, acquisition, manual-mode,
  orientation, dropped-frame, wake-lock and backgrounding checks.
- Real same-network and cross-network PeerJS/WebRTC sessions, QR scanning,
  signalling failures, blocked CDNs and restrictive network conditions.
- Full-navigation ES-module loading on the actual HTTPS deployment and a refresh
  of both devices after uploading the new files.
- Comparison with a calibrated instrument across real LCD/OLED displays, lighting,
  camera models, HDR/tone-mapping settings and viewing angles. No quantitative
  accuracy or repeatability guarantee is established here.
- ICC/CAL application and safe rollback with actual Windows/macOS/Linux loaders;
  behaviour with existing profiles, wide-gamut displays and GPU LUTs.
- Physical uniformity/perspective/lens-shading effects and temporal aliasing.

Preserve the original project and current monitor profile while evaluating this
revision. Raw JSON export remains the safest way to retain an experimental run.
