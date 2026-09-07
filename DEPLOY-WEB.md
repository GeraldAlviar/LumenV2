# Upload Lumen 2.1 using GitHub's website

The files are already updated. No source-code editing, build command or repository-name replacement is needed. This package has not been pushed to your GitHub account.

## Update your existing LumenV2 repository

1. Download and extract **lumen-v2.1.zip**. Open the extracted **lumen** folder.
2. On GitHub, open **GeraldAlviar / LumenV2**, then its **Code** tab and repository root.
3. Select **Add file → Upload files**.
4. Drag **the contents inside `lumen`**, including its `css` and `js` folders, into the upload area. Preserve the folder structure. Do not upload the ZIP or create `LumenV2/lumen/index.html`.
5. Review the proposed paths. The HTML files should be at the root; modules should be under `js/`, not scattered at the root. Commit the upload using a message such as **Update Lumen to 2.1.0**. Protected branches may require a branch and pull request instead of a direct commit.
6. Keep Pages publishing from **main → / (root)**. Check the **pages build and deployment** workflow in Actions until it succeeds.
7. Reload the monitor page and close/reopen the old iPhone tab. Both pages must show **v2.1.0** before pairing. The app rejects a version mismatch.

Expected site for the repository name already chosen:

`https://geraldalviar.github.io/LumenV2/`

You do not need to delete the repository or enable Pages again when its existing main/root setting is correct. Do not remove unrelated files you added separately. Existing filenames from this update are replacements; newly introduced files must also be uploaded.

## Runtime files that must travel together

At the root: `index.html`, `desktop.html`, `phone.html`.

Folder `css`: `app.css`.

Folder `js`: **every `.js` file in the supplied folder**, including the new alignment, runner, plans, preflight, storage, report, charts, UI, boot and version modules. Uploading only `phone.js` or only the HTML will break the update.

The README, changelog, testing documents, `package.json`, `.github`, `.gitignore`, scripts and tests are useful project files but not required to run the static site. The `.nojekyll` file explicitly selects plain static content. Show hidden files in your file manager to include dotfiles; missing the test workflow does not prevent the website running.

## First hardware acceptance test

Use **Quick Check first**, not Full. The sequence should be:

Connect → Start camera → Match squares → Lock sampling/check exposure → Ready → Run Quick Check → visible changing steps on both devices → report.

The monitor square and cyan markers remain visible during the measurement; the internal patches change. Do not follow individual patches by moving the phone. If the test cannot collect frames, it must now show a specific paused/error state rather than silently returning to Starting.

Test Pause/Resume once, then check the longer modes. A time estimate is not a real-device benchmark. Do not apply an experimental profile until the quality gates pass, and never treat an unlocked-camera report as a calibrated instrument reading.

## A separate repository is also supported

Creating a new repository for comparison is fine. Upload the same folder contents to its root and enable Pages from main/root. Relative links adapt to the new repository path. Browser storage depends on origin; export JSON before migrating important sessions. A new repository does not fix an incomplete upload or unsupported camera controls.

## Rollback

Keep the previous ZIP. To revert using the web UI, upload the previous complete runtime set to the same paths and commit. Extra unused modules can stay, but do not mix old HTML/controllers with new runtime modules while testing. Restore any display profile separately if you manually installed one.

GitHub reference: https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
Pages reference: https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
