# Lumen 2.2.0 validation

## Recorded results

- **115 Node automated tests passed.** This includes the original analysis/network/sampling/recovery checks, permissive-capture and held-out verification tests, and **10 bootstrap logic tests**.
- **24 Chromium DOM checks passed**, including manual pointer-based corner selection, immediate geometry lock, real Continue-anyway interaction, complete synthetic Quick capture after warning acceptance, raw exports, fresh verification, movement pause, cancellation, disconnect and resume.
- **3 ICC parsing checks passed** with Pillow/LittleCMS: sRGB, gamma 2.2 and gamma 2.4 fixtures opened and constructed transforms. This does not test GPU curves or install a profile.
- Source syntax, duplicate HTML IDs and local file references passed. **All 29 runtime file hashes** matched the release manifest.

These counts are software checks, not measured screen accuracy. Details are in `validation/`.

## What the tests actually run

`npm test` uses Node's test runner. Capture/transport/storage dependencies are isolated where appropriate. Bootstrap tests use the actual runtime bytes and SHA-256 implementation but simulate the DOM, fetch and controller import. They verify complete/missing/mismatched release handling, secure-context instructions, missing manifest, blocked PeerJS and optional QR failure.

`tests/dom_smoke.py` runs the actual HTML/CSS/controllers, rendering, sample acquisition logic and analysis in Chromium about:blank iframes. The camera is a generated test image and the PeerJS transport is an in-memory double. The loader adapts module imports for the restricted environment; it does **not** exercise native network module loading. It bypasses the startup file-check overlay so runtime UI scenarios can be isolated.

`tests/release_smoke.py` is a separate real-HTTP/native-module integration test for an unrestricted local environment. It was **not validated here**: browser navigation to localhost was blocked by the execution environment (`ERR_BLOCKED_BY_ADMINISTRATOR`). This is not included in the passed check counts. The test explicitly reports that environment limitation when encountered.

The browser tests neither request actual camera permission nor traverse a real network. They are not iOS Safari tests or Apple WebKit tests. Durations in the interface are design estimates, not device benchmarks.

## Run the checks

```sh
npm run check
npm test
npm run verify-release
```

Optional development dependencies for browser checks: Python, Playwright and Chromium. On a development machine with internet/package access, install Python Playwright and its Chromium browser, then configure `CHROMIUM_PATH` when it is not `/usr/bin/chromium`.

```sh
python tests/dom_smoke.py
python tests/release_smoke.py
```

The independent ICC smoke check additionally needs Pillow built with LittleCMS:

```sh
python tests/icc_smoke.py
```

`npm run release` updates hashes after runtime edits. Never generate a manifest from a mixed source tree or reuse a published build number for changed runtime content. The ZIP already contains the final manifest.

## Real iPhone acceptance checks still required

1. Upload the complete set and confirm **v2.2.0 / files verified** on both pages. Pair using the code and QR separately. Verify camera permission denied/retried and camera startup.
2. Select Quick. Place the square off-centre but fully visible. Verify Lock works with Excellent, Good, Fair, or Manual placement. Repeat with four manually tapped corners and with the guide fallback.
3. Confirm the sample squares sit in the two monitor patches. Lock must be immediate; Run must not require perfect overlap. Camera checks start only after Run.
4. Exercise Retry, Continue anyway and Stop on a recoverable warning. Continue must not produce the same blocking warning on every patch, must save its decision in JSON, and must disable correction exports. A new test must start without the old consent.
5. Verify missing frames/severe clipping still produce actionable pauses rather than fabricated readings. Test movement: small shifts/brief marker loss should not immediately pause; sustained movement should. Check the explicit tracking-off recovery path.
6. Complete all modes. Check progress on both devices, elapsed time and remaining-time behaviour. Measure actual device durations before changing the displayed estimates.
7. Disconnect/reconnect, background Safari, lock/unlock the phone, reload each side, and simulate unavailable storage. Saved work must not silently disappear. Resume must recheck the reference. Changed monitor settings should use a fresh test.
8. Run before/after verification after changing nothing, then after an intentional monitor setting adjustment. Confirm baseline JSON remains available and low-confidence results are labelled. Do not assume that a numerical improvement proves calibrated accuracy.
9. Compare results with a calibrated reference instrument before claiming physical accuracy. Test ICC/CAL on a disposable/test profile and verify operating-system restoration separately. Applying/undoing a profile is outside this browser app.

## Known limits

Unconfirmed Safari exposure/white-balance controls can allow useful diagnostics but prevent correction exports. No camera-specific spectral/RAW model is provided. Reference ratios cannot undo arbitrary local tone mapping. Marker tracking is heuristic and may fail; manual sampling assumes the phone stays still. Uniformity is conditional and includes lens/angle/reflection errors. No reliable absolute white point, luminance, colour difference or gamut measurement is supplied.
