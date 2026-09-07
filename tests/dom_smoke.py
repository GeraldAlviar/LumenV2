"""DOM-only smoke checks: local HTML/CSS/modules in about:blank frames.
No browser navigation, real camera access or external network is attempted.
Uses in-memory test doubles for storage, camera acquisition and transport.
"""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)

# Test-only module wrapper: imports become scoped references to the same source
# modules. Production files are not rewritten on disk and remain ES modules.
def modules():
    sources = {}
    for path in (ROOT / 'js').glob('*.js'):
        text = path.read_text()
        exports = re.findall(r'export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)', text)
        for group in re.findall(r'export\s*\{([^}]+)\}\s*;', text):
            exports.extend(n.strip() for n in group.split(','))
        text = re.sub(r"import\s*\{([^}]+)\}\s*from\s*'\./([^']+)';", lambda m: f'const {{{m.group(1)}}} = await __load({json.dumps(m.group(2))});', text, flags=re.S)
        text = re.sub(r'export\s*\{[^}]+\}\s*;', '', text)
        text = re.sub(r'\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)', '', text)
        # about:blank has no deploy URL; host explicitly in the test instead.
        if path.name == 'desktop.js':
            text = text.replace('else startHosting();', 'else { /* explicit test hosting */ }')
        sources[path.name] = text + '\nreturn {' + ','.join(exports) + '};'
    return sources

def html(name):
    text = (ROOT / name).read_text()
    text = re.sub(r'<script\b[^>]*>.*?</script>', '', text, flags=re.S)
    text = text.replace('<link rel="stylesheet" href="css/app.css">', '<style>' + (ROOT / 'css/app.css').read_text() + '</style>')
    return text

checks = []
errors = []
def checked(name):
    checks.append(name); print('PASS:', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
    page = browser.new_page(viewport={'width': 1720, 'height': 1200})
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.set_content('<iframe id="desktop" style="width:1250px;height:1180px;border:0"></iframe><iframe id="phone" style="width:390px;height:1180px;border:0"></iframe>')
    local_peer = (ROOT / 'tests/fake-local-peer.js').read_text()
    frames = {}
    for name in ['desktop', 'phone']:
        frame = page.locator('#' + name).element_handle().content_frame()
        frame.set_content(html(name + '.html'))
        frame.evaluate("""() => {
          const values = new Map();
          Object.defineProperty(window, 'localStorage', { value: { setItem:(k,v)=>values.set(k,String(v)), getItem:k=>values.get(k)??null, removeItem:k=>values.delete(k) }});
          window.__downloads = []; window.__blobs = new Map();
          const create = URL.createObjectURL.bind(URL);
          URL.createObjectURL = blob => { const url = create(blob); __blobs.set(url, blob); return url; };
          HTMLAnchorElement.prototype.click = function () { __downloads.push({ name:this.download, blob:__blobs.get(this.href) }); };
        }""")
        frame.evaluate(local_peer)
        frame.evaluate("""sources => {
          const cache = {}, AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          window.__load = async name => cache[name] ||= new AsyncFunction('__load', sources[name])(__load);
        }""", modules())
        frame.evaluate(f"__load('{name}.js')")
        frames[name] = frame
    d, f = frames['desktop'], frames['phone']
    d.locator('#demo-session').click()
    assert d.locator('svg.chart').count() == 2
    assert 'SIMULATED' in d.locator('#report-label').inner_text()
    assert d.locator('#dl-icc').is_disabled()
    checked('Demo produces two SVG charts, a simulation label and disabled correction buttons')
    d.locator('#dl-json').click()
    assert d.evaluate('(async () => JSON.parse(await __downloads.at(-1).blob.text()).synthetic)()')
    checked('Demo JSON export retains the simulation flag')
    d.evaluate("""async () => {
      const { syntheticReadings } = await __load('demo.js'); const r = syntheticReadings();
      lumen.ingest({ readings:r, target:'srgb', complete:true, expected:r.length, uniformity:null, flicker:null, sessionId:'fixture' });
    }""")
    assert d.locator('#dl-icc').is_disabled()
    d.locator('#accept-experimental').check()
    assert d.locator('#dl-icc').is_enabled()
    checked('Quality-passing fixture still requires explicit export acknowledgement')
    for selector in ['#dl-icc', '#dl-cal', '#dl-csv', '#dl-json']:
        before = d.evaluate('__downloads.length'); d.locator(selector).click()
        assert d.evaluate('__downloads.length') == before + 1
        assert d.evaluate('__downloads.at(-1).blob.size') > 100
    checked('All four export actions create non-empty blobs through the production handlers')
    saved = d.evaluate('(async()=>await __downloads.at(-1).blob.text())()')
    (OUT / 'dom-sample.json').write_text(saved)
    d.evaluate("""async () => {
      const { syntheticReadings } = await __load('demo.js'); const { RUNS } = await __load('patches.js');
      const r = syntheticReadings(RUNS.gamut.build());
      lumen.ingest({ readings:r, target:'gamma22', complete:true, expected:r.length, uniformity:null, flicker:null });
    }""")
    assert d.locator('#eotf-card').is_hidden()
    assert d.locator('#chart-eotf').inner_html() == ''
    assert d.locator('#dl-icc').is_disabled()
    checked('A colour-only result clears previous greyscale charts and blocks correction export')
    d.locator('#session-file').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':b'{invalid'})
    d.wait_for_function("document.querySelector('#status').textContent.includes('not a valid JSON')")
    assert d.locator('#report').is_visible()
    checked('Malformed JSON is rejected without destroying the existing report')
    d.locator('#session-file').set_input_files({'name':'valid.json','mimeType':'application/json','buffer':saved.encode()})
    d.wait_for_function("document.querySelector('#status').textContent.includes('Saved session opened')")
    assert d.locator('#eotf-card').is_visible()
    checked('A valid session import recomputes the report from raw readings')
    d.locator('#demo-session').click(); d.locator('#restore-session').click()
    assert 'SIMULATED' not in d.locator('#report-label').inner_text()
    d.locator('#clear-saved').click()
    assert d.locator('#restore-session').is_hidden()
    checked('Restore and clear-saved controls operate without altering current results')
    d.locator('#restart').click()
    d.evaluate("lumen.link.host('ACDEG')")
    f.locator('#room-input').fill('ACDEG'); f.locator('#join').click()
    f.wait_for_function("lumen.link.state === 'open'")
    assert f.locator('#run').is_disabled()
    checked('Production phone form and Link controller pair over the in-memory test transport')

    # Acquisition only is mocked. Real sampling and cancellation code is retained.
    f.evaluate("""async () => {
      const { Sensor } = await __load('sensor.js');
      Sensor.prototype.start = async function () {
        this.running = true; this.canvas.width = 480; this.canvas.height = 270;
        Object.defineProperties(this.video, { videoWidth:{value:480,configurable:true}, videoHeight:{value:270,configurable:true} });
        this.ctx.fillStyle='#888'; this.ctx.fillRect(0,0,240,270); this.ctx.fillStyle='#aaa'; this.ctx.fillRect(240,0,240,270);
        const tick = () => { this.lastFrame=this._readBoth(); this.dispatchEvent(new CustomEvent('frame',{detail:this.lastFrame})); };
        tick(); const timer=setInterval(tick,33); this.addEventListener('stop',()=>clearInterval(timer),{once:true});
        return {};
      };
    }""")
    f.locator('#start-camera').click()
    f.wait_for_selector('#align:not(.hidden)')
    assert f.locator('#run').is_enabled()
    sizes = f.evaluate("""() => {
      const a=document.querySelector('#reticles').getBoundingClientRect(), b=document.querySelector('.reticle').getBoundingClientRect();
      return {w:b.width,h:b.height,expected:0.15*Math.min(a.width,a.height)};
    }""")
    assert abs(sizes['w']-sizes['h'])<1 and abs(sizes['w']-sizes['expected'])<1
    checked('Camera-ready UI enables actions and reticles match actual disc-sampling dimensions')
    f.locator('#run').click(); f.wait_for_function("lumen.state.mode === 'run'",timeout=2000)
    assert f.locator('#flicker').is_disabled() and f.locator('#target').is_disabled()
    f.locator('#cancel').click(); f.wait_for_function("lumen.state.mode === null",timeout=2000)
    checked('Cancellation interrupts settling and prevents overlapping test modes')
    f.evaluate("""async () => {
      const { syntheticReadings }=await __load('demo.js');const { RUNS }=await __load('patches.js');
      const readings=syntheticReadings(RUNS.quick.build());let index=0;
      lumen.state.sensor.measure=async()=>structuredClone(readings[index++].result);
    }""")
    f.locator('#run').click()
    f.wait_for_function("lumen.state.mode === null && lumen.state.complete",timeout=12000)
    d.wait_for_selector('#report:not(.hidden)')
    assert d.evaluate('lumen.state.readings.length === lumen.state.expected')
    assert d.locator('#eotf-card').is_visible()
    assert f.locator('#progress').get_attribute('aria-valuenow') == '100'
    checked('A complete synthetic run traverses render acknowledgements and delivers every reading to the report')
    # Render desktop content in its actual browser frame for visual inspection.
    # Expand the iframe so the screenshot includes all report cards.
    height = d.evaluate('document.documentElement.scrollHeight') + 40
    page.locator('#desktop').evaluate('(node,h)=>node.style.height=h+"px"',height)
    page.set_viewport_size({'width':1720,'height':height+40})
    d.locator('#ui').screenshot(path=str(OUT / 'dom-completed-report.png'))
    page.locator('#desktop').evaluate('node=>node.style.height="1180px"')
    page.set_viewport_size({'width':1720,'height':1200})
    f.locator('#uniformity').click(); f.wait_for_selector('#screen-bounds:not(.hidden)')
    assert f.locator('#capture-uniformity').is_visible() and f.locator('#run').is_disabled()
    f.locator('#cancel').click(); f.wait_for_function("lumen.state.mode === null")
    checked('Uniformity requires a separate alignment/capture step and supports cancellation')
    f.locator('#flicker').click(); f.wait_for_function("lumen.state.mode === 'flicker'")
    d.evaluate('lumen.link.conn.close()'); f.wait_for_function("lumen.state.mode === null",timeout=2500)
    assert f.locator('#pair').is_visible() and f.locator('#run').is_disabled()
    assert f.evaluate('lumen.state.sensor.running') is False
    checked('Connection loss cancels active measurement, stops sampling and restores pairing controls')
    assert f.evaluate('document.documentElement.scrollWidth <= innerWidth')
    checked('Phone UI has no document-level horizontal overflow at 390 pixels')
    assert not errors, errors
    checked('No uncaught JavaScript errors in the exercised DOM workflows')
    (OUT / 'dom-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'errors':errors,'scope':'DOM only; mocked acquisition, storage and transport'},indent=2))
    browser.close()
print(len(checks),'DOM checks passed.')
