# Upload Lumen 2.2.0 using GitHub's website

This ZIP is already prepared. No coding, terminal, npm install or new repository is required. Nothing has been pushed to GitHub automatically.

## Replace the matching website set

1. Extract **lumen-v2.2.zip** on your computer.
2. Open the folder that directly contains **index.html**.
3. Open your **LumenV2** repository's main **Code** page, at its root.
4. Choose **Add file > Upload files**. Drag the extracted project contents into the upload area. Drag the **css** and **js** folders themselves, not their loose contents.
5. Check the paths and commit the upload. Existing paths replace their old versions. Keep any unrelated files you added separately. Deleting the repository is not required.
6. Leave Pages publishing from your existing **main > / (root)** configuration. Wait for **pages build and deployment** to succeed.
7. Reload both devices. Look for **v2.2.0 / files verified**, not just a version number.

Required website paths:

```text
LumenV2/
  index.html
  phone.html
  desktop.html
  release-manifest.json
  .nojekyll
  css/
    app.css
  js/
    ... every supplied JavaScript file, including boot.js ...
```

Do not upload the ZIP itself, put the site inside an extra project subfolder, flatten `js/`, or mix it with a previous ZIP. In particular, **release-manifest.json and the entire js folder are new/updated and must be uploaded**. Documentation, tests and scripts can be uploaded with the full project; they are not needed for the website to run. There are fewer than 100 files in the complete archive.

The `.nojekyll` file is hidden on some systems. Enable viewing hidden files when selecting the project contents. It tells Pages to serve this static site without Jekyll processing.

## First test

Choose **Quick Check** on the phone, then:

**Connect > Start camera > position approximately > Lock sample positions > Run.**

When automatic detection is unreliable, select **Mark four corners** and tap the monitor markers in this order: **top-left (magenta), top-right, bottom-right, bottom-left**. The guide does not have to overlap perfectly. Check the two small sampling squares are inside their patches before locking.

A recoverable warning now offers **Continue anyway / diagnostic report**. This collects uncertain readings and keeps raw results available, while disabling ICC/CAL correction for that session. Missing frames or severely clipped/absent signal still need correcting.

## A file-check error

Read the filename shown. Upload the complete matching set, including the manifest, and wait for deployment again. The page now names a missing or mismatched file rather than leaving empty dropdowns and dead buttons. A blocked PeerJS CDN instead needs a network/content-blocker check.

A confirmed installation still needs a real iPhone acceptance run. See TESTING.md; software tests are not proof of camera accuracy.

GitHub's official upload instructions: https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository
