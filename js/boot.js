/* Release integrity gate. Runs before UI controllers so mixed uploads fail visibly. */
(() => {
  'use strict';
  const build = '2.2.0';
  const root = document.documentElement;
  const box = document.getElementById('boot-status');
  const message = document.getElementById('boot-message');
  const retry = document.getElementById('boot-retry');
  const main = document.querySelector('main');
  if (!box || !message || !main) return;
  main.inert = true;
  retry.addEventListener('click', () => location.reload());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  const fail = error => {
    clearTimeout(timer); controller.abort();
    root.dataset.boot = 'failed'; box.hidden = false;
    document.getElementById('boot-title').textContent = 'Website files need attention';
    message.textContent = (error?.name === 'AbortError' ? 'The website file check took too long. Check the connection and retry.' : String(error?.message || error)) + ' Upload the complete 2.2.0 package together at the repository root, wait for deployment, then reload both devices. Saved measurements have not been deleted.';
    retry.hidden = false;
  };
  async function readFile(path) {
    const url = new URL(path, location.href);
    url.hash = ''; url.search = 'v=' + build;
    const response = await fetch(url, { cache: 'reload', signal: controller.signal });
    if (!response.ok) throw new Error(`${path} could not be loaded (HTTP ${response.status}).`);
    return response.arrayBuffer();
  }
  async function library(url, globalName) {
    if (window[globalName]) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = url; script.async = true;
      const timeout = setTimeout(() => { script.remove(); reject(new Error(`${globalName} could not be loaded from its CDN. Check content blockers and network access.`)); }, 15000);
      script.onload = () => { clearTimeout(timeout); window[globalName] ? resolve() : reject(new Error(`${globalName} did not initialise.`)); };
      script.onerror = () => { clearTimeout(timeout); reject(new Error(`${globalName} could not be loaded. Check content blockers and network access.`)); };
      document.head.append(script);
    });
  }
  async function start() {
    root.dataset.boot = 'checking';
    if (!window.isSecureContext || !crypto.subtle) throw new Error('Open the HTTPS GitHub Pages address, not a downloaded HTML file. Camera access and file verification need a secure page.');
    if (root.dataset.build !== build) throw new Error('This page and its startup script are from different releases.');
    const response = await fetch(new URL('release-manifest.json', location.href), { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('release-manifest.json is missing. The upload is incomplete.');
    const manifest = await response.json();
    if (manifest.build !== build || !Array.isArray(manifest.files) || manifest.files.length < 10 || manifest.files.length > 80) throw new Error('The release manifest does not match this page.');
    let next = 0, done = 0;
    const verify = async () => {
      while (next < manifest.files.length) {
        if (controller.signal.aborted) return;
        const item = manifest.files[next++];
        if (!/^(?:[a-z0-9-]+\.html|(?:js|css)\/[a-z0-9-]+\.(?:js|css))$/.test(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('The release manifest contains an invalid file entry.');
        const bytes = await readFile(item.path);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), x => x.toString(16).padStart(2, '0')).join('');
        if (controller.signal.aborted) return;
        if (hash !== item.sha256) throw new Error(`${item.path} is from another build or was modified. The website files are mixed.`);
        message.textContent = `Checking website files: ${++done}/${manifest.files.length}.`;
      }
    };
    await Promise.all(Array.from({ length: 5 }, verify));
    if (controller.signal.aborted) throw controller.signal.reason || new Error('The website file check was interrupted.');
    clearTimeout(timer);
    message.textContent = 'Website files match. Starting Lumen...';
    const role = root.dataset.role;
    if (role === 'phone' || role === 'desktop') {
      await library('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js', 'Peer');
      if (role === 'desktop') {
        try { await library('https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js', 'QRious'); }
        catch { /* Pairing by room code works without the optional QR renderer. */ }
      }
      await import(`./${role}.js?v=${build}`);
    }
    root.dataset.boot = 'ready';
    window.lumenRelease = Object.freeze({ build, checkedFiles: manifest.files.length });
    for (const label of document.querySelectorAll('.build-label')) label.textContent = `v${build} / files verified`;
    box.hidden = true; main.inert = false; root.classList.remove('booting');
  }
  start().catch(fail);
})();
