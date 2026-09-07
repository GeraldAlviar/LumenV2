# Changelog

## 2.2.0 - permissive capture and transparent diagnostics

Base: the last supplied `lumen-v2.1-full.zip`. This is a complete matching replacement, not a patch to mix with the earlier differently structured V2.1 archive.

### Main fixes

- Removed camera quality/preflight from Lock sampling. Lock immediately records geometry and makes Run available when paired with an active camera.
- Added an explicit bounded warning-review state on both devices. Continue accepts recoverable warnings once per session; retries and stop remain separate actions.
- Fixed the second quality gate in the patch loop so it no longer rejects a previously accepted diagnostic policy. Missing/invalid signal and severe clipping are still checked on every patch.
- Replaced the generic capture error with actionable reasons and manual selection/recovery guidance.
- Graded actual detected geometry without enforcing guide overlap; added manual four-corner registration and undo.
- Added tolerant, persistent movement checks and an explicit option to disable unreliable visual pauses.
- Added startup file verification with path-specific missing/mixed-file errors. An outstanding hash worker cannot overwrite a failure message with stale progress.

### Functionality

- Added repeated-reference captures across all four test modes; drift is recorded and reviewed, not silently compensated.
- Added four held-out tonal samples outside fitting/calibration data, plus a separate 18-reading before/after verification plan with new session ID and saved baseline.
- Added optional monitor-control selection, light/dark step pattern and “Close enough” return action.
- Preserved the four modes, separated simple/technical targets, Beginner/Advanced UI, dual-device progress, retries, cancellation, device-local checkpoint recovery and full report coverage.
- Extended session validation and metadata to record accepted warnings, diagnostic-only status, monitor controls, reference checks and compact comparison summaries.
- Disabled correction export for accepted diagnostic warnings, verification-only captures, unconfirmed exposure/white-balance locks and other conservative quality failures. Raw data export remains available.
- Bumped build to 2.2.0, peer protocol to 3 and measurement plan to 2. Older reports remain readable but old plans cannot resume.

### Validation

See TESTING.md for recorded checks and limitations. No real iPhone camera, physical display accuracy, real-network WebRTC or operating-system calibration installation was validated in this environment.
