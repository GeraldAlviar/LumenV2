# V2.1 replacement manifest

Compared byte-for-byte with the earlier `lumen-improved.zip`.
No files need deleting. Replace the website files together; do not mix builds.

## Minimal website upload

```text
index.html
desktop.html
phone.html
css/
js/
```

The website archive contains 25 files, including all 21 JavaScript modules.
`js/colour.js` and `js/patches.js` are included unchanged so the folder is complete.

## Existing source files changed

```text
CHANGELOG.md
README.md
TESTING.md
css/app.css
desktop.html
index.html
js/analysis.js
js/async.js
js/demo.js
js/desktop.js
js/icc.js
js/net.js
js/phone.js
js/quality.js
js/sensor.js
js/session.js
js/validation.js
package.json
phone.html
tests/browser_smoke.py
tests/core.test.js
tests/dom_smoke.py
tests/net.test.js
tests/sensor.test.js
```

## New source files

```text
CHANGE-MANIFEST.md
UPLOAD-GUIDE.md
js/alignment.js
js/config.js
js/display.js
js/modes.js
js/motion.js
js/report.js
js/runner.js
js/storage.js
tests/workflow.test.js
```

## Unchanged files retained in full source

```text
.github/workflows/test.yml
.gitignore
js/colour.js
js/patches.js
scripts/check.mjs
scripts/serve.mjs
tests/fake-local-peer.js
tests/fake-peer.js
tests/icc_smoke.py
```

Both archives have the website at the archive root, not inside another lumen directory.
These packages do not change the remote GitHub repository automatically.
