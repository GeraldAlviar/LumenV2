"""Browser regression checks with fake camera + mocked Peer transport.
Run the static server, install Python Playwright, then run this file.
No real display accuracy or Internet/WebRTC traversal is tested here.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)
BASE = os.environ.get('LUMEN_TEST_URL', 'http://127.0.0.1:8080')
checks = []
errors = []
def checked(name):
    checks.append(name)
    print('PASS:', name, flush=True)

def observe(page):
    page.on('pageerror', lambda error: errors.append(str(error)))

with sync_playwright() as p:
    executable = os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium')
    browser = p.chromium.launch(executable_path=executable, headless=True, args=[
        '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ])
    context = browser.new_context(viewport={'width': 1280, 'height': 920}, accept_downloads=True,
                                  permissions=['camera', 'clipboard-write'])
    fake_peer = (ROOT / 'tests/fake-peer.js').read_text()
    def external(route):
        if 'peerjs' in route.request.url:
            route.fulfill(status=200, content_type='text/javascript', body=fake_peer)
        else:
            route.fulfill(status=200, content_type='text/javascript', body='/* External asset unavailable in test. */')
    context.route('https://**/*', external)
    desktop = context.new_page(); observe(desktop)
    desktop.goto(BASE + '/desktop.html?demo=1')
    desktop.wait_for_selector('#report:not(.hidden)')
    assert 'SIMULATED' in desktop.locator('#report-label').inner_text()
    assert desktop.locator('#dl-icc').is_disabled()
    assert desktop.locator('svg.chart').count() == 2
    checked('Demo report renders two charts and blocks correction downloads')
    desktop.screenshot(path=str(OUT / 'demo-desktop.png'), full_page=True)
    with desktop.expect_download() as capture:
        desktop.locator('#dl-json').click()
    demo_download = capture.value; demo_download.save_as(str(OUT / 'demo-session.json'))
    assert json.loads((OUT / 'demo-session.json').read_text())['synthetic'] is True
    checked('Demo JSON keeps the simulation flag')

    desktop.evaluate("""async () => {
      const { syntheticReadings } = await import('./js/demo.js');
      const readings = syntheticReadings();
      window.lumen.ingest({ readings, target: 'srgb', expected: readings.length, complete: true,
        uniformity: null, flicker: null, synthetic: false, sessionId: 'browser-test' });
    }""")
    assert desktop.locator('#dl-icc').is_disabled()
    desktop.locator('#accept-experimental').check()
    assert desktop.locator('#dl-icc').is_enabled()
    checked('Quality-passing fixture requires explicit acknowledgement before export')
    for button, filename in [('dl-icc', 'sample.icc'), ('dl-cal', 'sample.cal'), ('dl-csv', 'sample.csv'), ('dl-json', 'sample.json')]:
        with desktop.expect_download() as capture:
            desktop.locator('#' + button).click()
        capture.value.save_as(str(OUT / filename))
        assert (OUT / filename).stat().st_size > 100
    checked('ICC, CAL, CSV and JSON downloads create non-empty files')
    desktop.evaluate("""async () => {
      const { syntheticReadings } = await import('./js/demo.js');
      const { RUNS } = await import('./js/patches.js');
      const readings = syntheticReadings(RUNS.gamut.build());
      window.lumen.ingest({ readings, target: 'gamma22', expected: readings.length, complete: true,
        uniformity: null, flicker: null, sessionId: 'gamut-test' });
    }""")
    assert desktop.locator('#eotf-card').is_hidden()
    assert desktop.locator('#chart-eotf').inner_html() == ''
    assert desktop.locator('#dl-icc').is_disabled()
    checked('Colour-only results clear old greyscale charts and disable LUT export')
    desktop.locator('#session-file').set_input_files({'name': 'invalid.json', 'mimeType': 'application/json', 'buffer': b'{broken'})
    desktop.wait_for_function("document.querySelector('#status').textContent.includes('not a valid JSON')")
    assert desktop.locator('#report').is_visible()
    checked('Invalid JSON gives an error without replacing the report')
    desktop.locator('#session-file').set_input_files(str(OUT / 'sample.json'))
    desktop.wait_for_function("document.querySelector('#status').textContent.includes('Saved session opened')")
    assert desktop.locator('#eotf-card').is_visible()
    desktop.reload(); desktop.wait_for_selector('#restore-session:not(.hidden)')
    desktop.locator('#restore-session').click()
    assert desktop.locator('#eotf-card').is_visible()
    checked('Imported and locally saved sessions can be restored after reload')

    desktop.goto(BASE + '/desktop.html')
    desktop.wait_for_function("window.lumen?.link.state === 'waiting'")
    code = desktop.locator('#room-code').inner_text()
    assert len(code) == 5
    assert desktop.locator('#qr').is_hidden()
    checked('Pairing code remains usable when QR library is unavailable')
    phone = context.new_page(); observe(phone)
    phone.set_viewport_size({'width': 390, 'height': 844})
    phone.goto(BASE + '/phone.html?room=' + code)
    phone.locator('#join').click()
    phone.wait_for_selector('#console:not(.hidden)')
    desktop.wait_for_function("window.lumen.link.state === 'open'")
    assert phone.locator('#run').is_disabled()
    checked('Both pages pair through the test transport; camera-gated actions stay disabled')
    phone.locator('#start-camera').click()
    phone.wait_for_selector('#align:not(.hidden)', timeout=10000)
    phone.wait_for_function("window.lumen.state.sensor?.lastFrame != null")
    assert phone.locator('#run').is_enabled()
    sizes = phone.evaluate("""() => {
      const v = document.querySelector('#camera-viewport').getBoundingClientRect();
      const r = document.querySelector('.reticle').getBoundingClientRect();
      return { actual: r.width, expected: 0.15 * Math.min(v.width - 2, v.height - 2), height: r.height,
        videoRatio: document.querySelector('#cam').videoWidth / document.querySelector('#cam').videoHeight,
        viewportRatio: v.width / v.height };
    }""")
    assert abs(sizes['actual'] - sizes['height']) < 1
    assert abs(sizes['actual'] - sizes['expected']) < 1.5
    assert abs(sizes['videoRatio'] - sizes['viewportRatio']) < 0.02
    checked('Fake camera starts; reticles match the actual circular sample geometry')
    phone.screenshot(path=str(OUT / 'phone-alignment.png'), full_page=True)
    phone.locator('#run').click()
    phone.wait_for_function("window.lumen.state.mode === 'run'")
    assert phone.locator('#flicker').is_disabled()
    assert phone.locator('#target').is_disabled()
    phone.locator('#cancel').click()
    phone.wait_for_function("window.lumen.state.mode === null", timeout=2500)
    assert phone.locator('#run').is_enabled()
    desktop.wait_for_function("!document.body.classList.contains('measuring')")
    checked('Stop cancels settling immediately and overlapping modes are prevented')

    # Replace only sensor readings with idealised fixtures for a complete run.
    # The orchestration, render acknowledgements, messaging and UI remain real.
    phone.evaluate("""async () => {
      const { syntheticReadings } = await import('./js/demo.js');
      const { RUNS } = await import('./js/patches.js');
      const readings = syntheticReadings(RUNS.quick.build());
      let index = 0;
      window.lumen.state.sensor.measure = async () => structuredClone(readings[index++].result);
    }""")
    phone.locator('#run').click()
    phone.wait_for_function("window.lumen.state.complete && window.lumen.state.mode === null", timeout=15000)
    desktop.wait_for_selector('#report:not(.hidden)')
    assert desktop.evaluate('window.lumen.state.readings.length === window.lumen.state.expected')
    assert desktop.locator('#eotf-card').is_visible()
    assert phone.locator('#progress').get_attribute('aria-valuenow') == '100'
    checked('Complete simulated run reaches the monitor report with all reference readings')
    desktop.screenshot(path=str(OUT / 'completed-report.png'), full_page=True)

    phone.locator('#uniformity').click()
    phone.wait_for_selector('#screen-bounds:not(.hidden)')
    assert phone.locator('#capture-uniformity').is_visible()
    assert phone.locator('#run').is_disabled()
    phone.locator('#cancel').click()
    phone.wait_for_function("window.lumen.state.mode === null")
    assert phone.locator('#screen-bounds').is_hidden()
    checked('Uniformity requires explicit screen-bound alignment and supports cancellation')
    # Begin a long bounded operation then deliberately close the transport.
    phone.locator('#flicker').click()
    phone.wait_for_function("window.lumen.state.mode === 'flicker'")
    desktop.evaluate('window.lumen.link.conn.close()')
    phone.wait_for_function("window.lumen.state.mode === null", timeout=3000)
    assert phone.locator('#pair').is_visible()
    assert phone.locator('#run').is_disabled()
    assert phone.evaluate('window.lumen.state.sensor.running') is False
    checked('Disconnection cancels active work, stops the camera and exposes reconnection controls')
    # Mobile layout must not create document-level horizontal scrolling.
    assert phone.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    checked('Phone layout fits a 390-pixel viewport without horizontal overflow')
    assert not errors, errors
    checked('No uncaught browser JavaScript errors across the tested workflows')
    (OUT / 'browser-results.json').write_text(json.dumps({'passed': len(checks), 'checks': checks, 'pageErrors': errors}, indent=2))
    browser.close()
print(f'{len(checks)} browser checks passed.')
