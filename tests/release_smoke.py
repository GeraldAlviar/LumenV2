"""Real HTTP/ES-module startup + deployment-failure tests; PeerJS/CDN stubbed.
No camera emulation is used: camera errors are tested before permission. Not an
actual iPhone or real WebRTC test. Requires Playwright and local Chromium.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import sys
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
PORT = 8862
checks = []
def ok(text):
    checks.append(text)
    print('PASS:', text, flush=True)
server = subprocess.Popen(['node', 'scripts/serve.mjs'], cwd=ROOT, env={**os.environ, 'PORT': str(PORT)}, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for _ in range(40):
        try:
            with socket.create_connection(('127.0.0.1', PORT), timeout=.2): break
        except OSError: time.sleep(.1)
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), args=['--no-sandbox'])
        context = browser.new_context()
        context.route('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js', lambda route: route.fulfill(content_type='text/javascript', body=(ROOT/'tests/fake-peer.js').read_text()))
        context.route('https://cdnjs.cloudflare.com/ajax/libs/qrious/4.0.2/qrious.min.js', lambda route: route.fulfill(content_type='text/javascript', body='window.QRious=class { constructor(){this.canvas=document.createElement("canvas");}};'))
        page = context.new_page()
        errors=[]
        page.on('pageerror', lambda error: errors.append(str(error)))
        base=f'http://127.0.0.1:{PORT}/'
        for name in ['index.html', 'phone.html', 'desktop.html']:
            try:
                page.goto(base+name)
            except Exception as error:
                if 'ERR_BLOCKED_BY_ADMINISTRATOR' not in str(error): raise
                message='SKIPPED: this environment blocks browser navigation to localhost. Native HTTP/ES-module integration was not tested.'
                print(message,flush=True)
                (OUT/'release-checks.json').write_text(json.dumps({'status':'skipped','reason':message},indent=2))
                browser.close()
                sys.exit(0)
            page.wait_for_function('document.documentElement.dataset.boot === "ready"', timeout=20000)
            assert page.evaluate('window.lumenRelease.build')=='2.2.0'
            assert page.evaluate('window.lumenRelease.checkedFiles')>=29
            assert not page.locator('main').evaluate('e=>e.inert')
            assert not page.locator('#boot-status').is_visible()
            if name=='phone.html':
                assert page.locator('#target option').count()>=7
            ok(name+' starts through the real HTTP/ES module path after all runtime hashes match')
        # Two independent tabs, production network controller but synthetic signalling.
        phone=context.new_page();phone.goto(base+'phone.html')
        phone.wait_for_function('document.documentElement.dataset.boot === "ready"')
        code=page.locator('#room-code').inner_text()
        phone.locator('#room-input').fill(code);phone.locator('#join').click()
        phone.wait_for_function('lumen.state.paired')
        assert phone.locator('#start-camera').is_enabled()
        assert phone.locator('#run').is_disabled()
        ok('Matching builds pair across real tabs; Start camera is enabled and no empty target dropdown')
        phone.close()
        assert not errors,errors
        # Missing/mixed deployments fail before loading app controllers.
        for path,missing in [('js/phone.js',False),('js/capture.js',True),('release-manifest.json',True)]:
            page=context.new_page()
            def intercept(route,missing=missing):
                if missing: route.fulfill(status=404,body='Not found')
                else: route.fulfill(content_type='text/javascript',body='// stale file from another release')
            page.route(base+path+'*', intercept)
            page.goto(base+'phone.html')
            page.wait_for_function('document.documentElement.dataset.boot === "failed"',timeout=20000)
            assert path in page.locator('#boot-message').inner_text()
            assert page.evaluate('typeof window.lumen')=='undefined'
            assert page.locator('main').evaluate('e=>e.inert')
            assert page.locator('#boot-retry').is_visible()
            ok(('Missing ' if missing else 'Mismatched ')+path+' produces a named upload error before any controller starts')
            page.screenshot(path=str(OUT/('missing-'+path.replace('/','-')+'.png')))
            page.close()
        page=context.new_page()
        page.route('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',lambda route:route.abort())
        page.goto(base+'phone.html');page.wait_for_function('document.documentElement.dataset.boot === "failed"',timeout=20000)
        assert 'Peer' in page.locator('#boot-message').inner_text()
        assert page.evaluate('typeof window.lumen')=='undefined'
        ok('Blocked PeerJS CDN produces an actionable startup error, not dead controls')
        browser.close()
    (OUT/'release-checks.json').write_text(json.dumps({'checks':checks,'environment':'Chromium on localhost, real ES modules and SHA-256 fetch verification; CDN/PeerJS signalling replaced by test doubles'},indent=2))
    print(f'{len(checks)} release startup checks passed.')
finally:
    server.terminate()
    try: server.wait(timeout=4)
    except subprocess.TimeoutExpired: server.kill()
