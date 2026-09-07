# Upload this update with the GitHub website

Use `lumen-v2.1-web-update.zip` for the smallest website update. It contains only
the website files, with no extra enclosing `lumen` directory inside the ZIP.

1. Extract the ZIP on your computer. Do not upload the ZIP itself.
2. Open the root of your existing **GeraldAlviar/LumenV2** repository.
3. Select **Add file > Upload files**.
4. Drag these extracted items together into the upload area:

   ```text
   index.html
   desktop.html
   phone.html
   css/
   js/
   ```

5. Preserve the directory structure and commit the upload to the publishing branch.
   Review that existing paths are updated and new `js` files are added. Do not put
   another `lumen` or `web-update` folder above `index.html`.
6. Wait for that Pages deployment to succeed. The existing Pages settings can stay
   on the same branch and root directory. No new repository is required.
7. Refresh/reopen both devices. Confirm **v2.1.0** on each. Do not reuse the earlier
   `lumen-improved.zip`, which does not contain this update.

No files need deleting for this update. The entire `js` folder is important because
its modules import one another and use a shared build version.

`lumen-v2.1-full.zip` includes these identical website files plus tests,
developer scripts and documentation. Upload its root contents instead when you
also want the repository's tests/docs updated. There are no `node_modules` or Git
history files in either package. A complete file-change manifest accompanies the
full source; no changes have been pushed to GitHub automatically.

## First check after deployment

Use Quick Check first. Confirm the first patch advances, both devices show progress,
and a test failure gives a visible recovery message. This build has passed automated
software tests but still needs a real iPhone Safari capture test.
