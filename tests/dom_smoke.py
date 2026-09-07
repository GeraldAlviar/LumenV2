"""Browser DOM regression tests for Lumen 2.1.

Real HTML, CSS, UI controllers, rendering, sample collection and analysis run in
Chromium about:blank iframes. Camera acquisition and PeerJS are test doubles.
This tests neither real iPhone Safari nor physical display accuracy or NAT traversal.
"""
import json
import os
import re
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results'
OUT.mkdir(exist_ok=True)

def modules():
    sources = {}
    for path in (ROOT / 'js').glob('*.js'):
        text = path.read_text()
        exports = re.findall(r'export\s+(?:async\s+)?(?:function|class|const|let)\s+(\w+)', text)
        text = re.sub(r"import\s*\{([^}]+)\}\s*from\s*'\./([^']+)';", lambda m: f'const {{{m.group(1)}}} = await __load({json.dumps(m.group(2).split("?")[0])});', text, flags=re.S)
        for group in re.findall(r'export\s*\{([^}]+)\}\s*;', text):
            exports.extend(n.strip() for n in group.split(','))
        text = re.sub(r'export\s*\{[^}]+\}\s*;', '', text)
        text = re.sub(r'\bexport\s+(?=(?:async\s+)?(?:function|class|const|let)\b)', '', text)
        if path.name == 'desktop.js':
            text = text.replace('else startHosting();', 'else { /* explicit test hosting */ }')
        sources[path.name] = text + '\nreturn {' + ','.join(exports) + '};'
    return sources

def html(name):
    text = (ROOT / name).read_text()
    text = re.sub(r'<script\b[^>]*>.*?</script>', '', text, flags=re.S)
    return re.sub(r'<link rel="stylesheet" href="css/app\.css[^\"]*">', lambda _: '<style>' + (ROOT / 'css/app.css').read_text() + '</style>', text)

checks, errors = [], []
def checked(name):
    checks.append(name)
    print('PASS:', name, flush=True)

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'])
    page = browser.new_page(viewport={'width': 1740, 'height': 950})
    page.set_default_timeout(10000)
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('dialog', lambda d: d.accept())
    page.set_content('<style>body{margin:0;display:flex}</style><iframe id="desktop" style="width:1320px;height:940px;border:0"></iframe><iframe id="phone" style="width:390px;height:844px;border:0"></iframe>')
    frames = {}
    for name in ['desktop', 'phone']:
        frame = page.locator('#' + name).element_handle().content_frame()
        frame.set_content(html(name + '.html'))
        frame.evaluate("""() => {
          const data = new Map();
          Object.defineProperty(window,'localStorage',{value:{setItem:(k,v)=>data.set(k,String(v)),getItem:k=>data.get(k)??null,removeItem:k=>data.delete(k)}});
          window.__downloads=[];window.__blobs=new Map();
          const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);__blobs.set(url,blob);return url;};
          HTMLAnchorElement.prototype.click=function(){__downloads.push({name:this.download,blob:__blobs.get(this.href)});};
        }""")
        frame.evaluate((ROOT / 'tests/fake-local-peer.js').read_text())
        frame.evaluate("""sources => {
          const cache={}, AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
          window.__load=async name=>cache[name] ||= new AsyncFunction('__load',sources[name])(__load);
        }""", modules())
        frame.evaluate(f"__load('{name}.js')")
        frames[name] = frame
    d, f = frames['desktop'], frames['phone']
    d.locator('#demo-session').click()
    assert d.locator('svg.chart').count() == 2
    assert 'SIMULATED' in d.locator('#report-label').inner_text()
    assert d.locator('#dl-icc').is_disabled()
    checked('Demo renders curves and blocks correction export')
    d.locator('#dl-json').click()
    assert d.evaluate('(async()=>JSON.parse(await __downloads.at(-1).blob.text()).synthetic)()')
    checked('Demo JSON retains its simulated-data flag')
    d.evaluate("""async()=>{const {syntheticReadings}=await __load('demo.js');const r=syntheticReadings();lumen.ingest({readings:r,target:'srgb',complete:true,expected:r.length,sessionId:'fixture'});}""")
    assert d.locator('#dl-icc').is_disabled()
    d.locator('#accept-experimental').check()
    assert d.locator('#dl-icc').is_enabled()
    for selector in ['#dl-icc','#dl-cal','#dl-csv','#dl-json']:
        before=d.evaluate('__downloads.length');d.locator(selector).click()
        assert d.evaluate('__downloads.length')==before+1
        assert d.evaluate('__downloads.at(-1).blob.size')>100
    saved=d.evaluate('(async()=>await __downloads.at(-1).blob.text())()')
    checked('Quality-passing data requires acknowledgement and all four exports produce files')
    d.locator('#session-file').set_input_files({'name':'invalid.json','mimeType':'application/json','buffer':b'{bad'})
    d.wait_for_function("document.querySelector('#status').textContent.includes('not a valid JSON')")
    assert d.locator('#report').is_visible()
    d.locator('#session-file').set_input_files({'name':'valid.json','mimeType':'application/json','buffer':saved.encode()})
    d.wait_for_function("document.querySelector('#status').textContent.includes('Saved session opened')")
    checked('JSON import validates files without replacing a good report on error')
    d.locator('#restart').click();d.evaluate("lumen.link.host('ACDEG')")
    f.locator('#room-input').fill('ACDEG');f.locator('#join').click()
    f.wait_for_function('lumen.state.paired === true')
    assert f.locator('#run').is_disabled()
    checked('Pairing verifies the build before allowing a measurement')
    assert f.locator('#run-type').input_value()=='standard'
    assert f.locator('#target optgroup').count()==2
    assert f.locator('#run-type option').count()==4
    f.locator('#run-type').select_option('quick')
    assert '~45' in f.locator('#test-duration').inner_text()
    checked('Four modes, Standard default, estimates and separated target groups are available')
    # Draw a synthetic camera image of the CURRENT monitor patches. Sampling,
    # convergence, clipping validation and camera timeouts remain production code.
    f.evaluate("""async()=>{
      const {Sensor}=await __load('sensor.js');const {MODES}=await __load('modes.js');const {linearToSrgb}=await __load('colour.js');
      for(const m of Object.values(MODES)){m.sample.settleMs=8;m.sample.maxMs=1200;m.sample.minSamples=12;}
      const realMeasure=Sensor.prototype.measure;
      Sensor.prototype.measure=function(o={}){return realMeasure.call(this,{...o,settleMs:8,maxMs:1200,minSamples:12});};
      Sensor.prototype.start=async function(){
        this.running=true;this.canvas.width=480;this.canvas.height=640;
        Object.defineProperties(this.video,{videoWidth:{value:480,configurable:true},videoHeight:{value:640,configurable:true}});
        this.video.play=async()=>{};
        const context=this.ctx,w=480,h=640,side=345.6,x0=67.2,y0=147.2;
        const cameraColour=css=>{const rgb=css.match(/[\\d.]+/g).slice(0,3).map(Number);return 'rgb('+rgb.map(v=>Math.round(linearToSrgb(.001+.7*(v/255)**2.2)*255)).join(',')+')';};
        const monitor=window.top.document.querySelector('#desktop').contentDocument;
        const tick=()=>{
          if(window.__freezeFrames)return;
          context.fillStyle='#090909';context.fillRect(0,0,w,h);context.fillStyle='#000';context.fillRect(x0,y0,side,side);
          for(const [id,left] of [['patch-anchor',.13],['patch-test',.59]]){
            context.fillStyle=cameraColour(monitor.querySelector('#'+id).style.background||'rgb(160,160,160)');context.fillRect(x0+side*left,y0+side*.36,side*.28,side*.28);
          }
          const corners=[[x0,y0,'#bc00bc'],[x0+side,y0,'#00bcbc'],[x0+side,y0+side,'#00bcbc'],[x0,y0+side,'#00bcbc']];
          if(!window.__hideMarkers)for(const [x,y,c] of corners){context.fillStyle=c;context.fillRect(x-side*.025,y-side*.025,side*.05,side*.05);}
          if(window.__clip){context.fillStyle='#fff';context.fillRect(x0+side*.13,y0+side*.36,side*.28,side*.28);}
          this.lastFrame=this._readBoth();this.dispatchEvent(new CustomEvent('frame',{detail:this.lastFrame}));
        };
        tick();const timer=setInterval(tick,20);this.addEventListener('stop',()=>clearInterval(timer),{once:true});return {};
      };
    }""")
    f.locator('#start-camera').click()
    f.wait_for_function('lumen.state.sensor?.running && lumen.state.detected !== null')
    assert f.locator('#run').is_disabled()
    assert f.locator('#lock-sampling').is_enabled()
    checked('A camera alone is not ready: alignment and exposure setup are required')
    f.locator('#lock-sampling').click()
    f.wait_for_function('lumen.state.ready && !lumen.state.setupController',timeout=12000)
    assert f.locator('#run').is_enabled()
    assert f.evaluate('lumen.state.sensor.regions.anchor.shape')=='square'
    f.locator('#run').scroll_into_view_if_needed()
    geometry=f.evaluate("""()=>{const a=document.querySelector('#cam').getBoundingClientRect();return {top:a.top,bottom:a.bottom,width:a.width,height:a.height,screen:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth};}""")
    assert geometry['top']>=0 and geometry['bottom']<=geometry['screen'],geometry
    assert not geometry['overflow'],geometry
    checked('Locked square samples match the preview and sticky camera remains onscreen when Run is reached')
    page.locator('#phone').screenshot(path=str(OUT/'phone-ready.png'))
    page.locator('#desktop').screenshot(path=str(OUT/'monitor-alignment.png'))
    # Reproduce the reported bug: no frames AFTER the run begins.
    f.evaluate("""()=>{window.__freezeOnSample=e=>{if(e.detail.phase==='sampling'){window.__freezeFrames=true;lumen.runner.removeEventListener('status',__freezeOnSample);}};lumen.runner.addEventListener('status',__freezeOnSample);}""")
    f.locator('#run').click()
    f.wait_for_function("lumen.runner.phase==='paused' && !lumen.runner.busy",timeout=20000)
    d.wait_for_function("lumen.state.phase==='paused'")
    assert f.evaluate('lumen.runner.session.readings.length')==0
    assert f.evaluate('lumen.runner.session.telemetry.retries')==2
    assert 'stalled' in d.locator('#stage-status').inner_text().lower()
    assert d.locator('#stage').is_visible()
    assert f.locator('#help-dialog').is_visible()
    checked('Zero-frame failure retries twice then shows a paused error on BOTH devices, keeping the square visible')
    page.locator('#desktop').screenshot(path=str(OUT/'monitor-paused.png'))
    f.locator('#help-close').click();f.evaluate('window.__freezeFrames=false')
    f.locator('#show-alignment').click();f.wait_for_function('lumen.state.detected!==null')
    f.locator('#lock-sampling').click();f.wait_for_function('lumen.state.ready && !lumen.state.setupController',timeout=12000)
    f.locator('#resume').click()
    f.wait_for_function("lumen.runner.session?.complete && !lumen.runner.busy",timeout=30000)
    d.wait_for_function('lumen.state.complete === true',timeout=10000)
    assert f.evaluate('lumen.runner.session.readings.length')==f.evaluate('lumen.runner.session.expected')
    assert d.evaluate('lumen.state.readings.length')==f.evaluate('lumen.runner.session.expected')
    assert f.locator('#phone-report').is_visible()
    assert d.locator('#report').is_visible()
    checked('Realign and Resume finish all Quick patches; both devices receive the full report')
    assert 'Not measured in Quick Check' in f.locator('#phone-coverage').inner_text()
    assert 'Not measured in Quick Check' in d.locator('#report-coverage').inner_text()
    assert f.locator('#phone-quality').inner_text()=='Fair'
    checked('Reports show omitted measurements and downgrade unconfirmed exposure instead of claiming calibrated accuracy')
    page.locator('#desktop').screenshot(path=str(OUT/'monitor-report.png'))
    # The same actual DOM handles clipping before a subsequent run.
    f.evaluate('window.__clip=true');f.locator('#show-alignment').click();f.locator('#lock-sampling').click()
    f.wait_for_function("!lumen.state.setupController && document.querySelector('#help-dialog').open",timeout=12000)
    assert f.locator('#run').is_disabled()
    assert 'overexposed' in f.locator('#help-title').inner_text().lower()
    checked('Clipping blocks readiness and presents corrective instructions, not a silent test failure')
    f.locator('#help-close').click();f.evaluate('window.__clip=false;window.__hideMarkers=true')
    f.locator('#show-alignment').click();f.wait_for_function('lumen.state.detected===null')
    assert f.locator('#lock-sampling').is_enabled()
    f.locator('#lock-sampling').click();f.wait_for_function('lumen.state.ready && !lumen.state.setupController',timeout=12000)
    assert f.evaluate('lumen.state.setupInfo.automatic') is False
    checked('Manual square lock remains available when automatic marker detection cannot confirm alignment')
    # Test duplicate-run prevention and explicit Stop using current production code.
    f.locator('#run').click();f.wait_for_function('lumen.runner.busy')
    assert f.locator('#run').is_disabled();assert f.locator('#run-type').is_disabled()
    f.locator('#cancel').click();f.wait_for_function('!lumen.runner.busy')
    d.wait_for_function("lumen.state.phase==='stopped'")
    assert f.evaluate('lumen.runner.session.complete') is False
    checked('Stop cancels the loop, retains progress and synchronises the stopped state')
    f.locator('#help-close').click();f.evaluate('window.__hideMarkers=false')
    f.locator('#show-alignment').click();f.locator('#lock-sampling').click();f.wait_for_function('lumen.state.ready && !lumen.state.setupController',timeout=12000)
    f.locator('#resume').click();f.wait_for_function("lumen.runner.session.readings.length>=1 && lumen.runner.busy",timeout=15000)
    f.evaluate('lumen.link.conn.close()')
    f.wait_for_function('!lumen.runner.busy')
    assert f.evaluate('lumen.runner.session.readings.length')>=1
    assert d.evaluate('lumen.state.backup.readings.length')>=1
    checked('Disconnect interrupts capture without deleting the checkpoints on either device')
    f.locator('#help-close').click();f.locator('#room-input').fill('ACDEG');f.locator('#join').click();f.wait_for_function('lumen.state.paired')
    assert f.locator('#resume').is_disabled()
    f.locator('#show-alignment').click();f.locator('#lock-sampling').click();f.wait_for_function('lumen.state.ready && !lumen.state.setupController',timeout=12000)
    f.locator('#resume').click();f.wait_for_function('lumen.runner.session.complete && !lumen.runner.busy',timeout=30000)
    checked('Reconnection requires revalidation and resumes the remaining patches successfully')
    assert not errors,errors
    (OUT/'dom-checks.json').write_text(json.dumps({'checks':checks,'pageErrors':errors,'environment':'Chromium DOM only; synthetic camera acquisition; in-memory transport'},indent=2))
    f.evaluate('lumen.state.sensor?.stop();lumen.link.destroy()');d.evaluate('lumen.link.destroy()')
    browser.close()
print(f'{len(checks)} DOM checks passed. No real iPhone Safari camera, screen accuracy or network traversal was tested.')
