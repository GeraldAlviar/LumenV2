// Bootstrap logic tests: exact local runtime bytes + real SHA-256, simulated DOM,
// fetch and script loading. Not an HTTP or native-module browser test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const code = readFileSync(new URL('js/boot.js', root), 'utf8').replace('await import(`./${role}.js?v=${build}`)', 'await window.__loadApp(role)');
async function boot({ path = null, corrupt = false, build = '2.2.0', secure = true, role = 'phone', peerFails = false, qrFails = false, staleManifest = false } = {}) {
  const nodes = new Map(['boot-status','boot-message','boot-title','boot-retry','main'].map(k => [k, {hidden:false,textContent:'',inert:false,addEventListener(){}}]));
  const label={textContent:''}, imported=[], fetched=[];
  const html={dataset:{build,role},classList:{remove(){}}};
  const context={console,URL,AbortController,Uint8Array,setTimeout,clearTimeout,crypto:webcrypto,isSecureContext:secure,
    document:{documentElement:html,getElementById:id=>nodes.get(id),querySelector:()=>nodes.get('main'),querySelectorAll:()=>[label],
      createElement:()=>({remove(){}}),head:{append(script){queueMicrotask(()=>{
        const qr=script.src.includes('qrious');
        if(qr?qrFails:peerFails)script.onerror();else {context[qr?'QRious':'Peer']=class {};script.onload();}
      });}}},
    location:{href:'https://example.test/LumenV2/phone.html',reload(){}},
    fetch:async url=>{
      const name=new URL(url).pathname.replace('/LumenV2/','');fetched.push(name);
      if(name===path && !corrupt)return {ok:false,status:404};
      if(name==='release-manifest.json')return {ok:true,json:async()=>{const m=JSON.parse(readFileSync(new URL(name,root),'utf8'));if(staleManifest)m.build='old';return m;}};
      const bytes=name===path && corrupt?Buffer.from('//wrong source'):readFileSync(new URL(name,root));
      return {ok:true,arrayBuffer:async()=>Uint8Array.from(bytes).buffer};
    },__loadApp:async name=>{imported.push(name);},
  };
  context.window=context;vm.runInNewContext(code,context);
  const end=Date.now()+2000;
  while(!['ready','failed'].includes(html.dataset.boot)&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(['ready','failed'].includes(html.dataset.boot),'bootstrap finishes');
  return {html,nodes,label,imported,fetched};
}
test('complete release verifies every exact runtime byte and then loads phone controller',async()=>{
 const b=await boot();assert.equal(b.html.dataset.boot,'ready');assert.deepEqual(b.imported,['phone']);assert.match(b.label.textContent,/files verified/);assert.equal(b.nodes.get('main').inert,false);
 const manifest=JSON.parse(readFileSync(new URL('release-manifest.json',root),'utf8'));assert.equal(b.fetched.length,manifest.files.length+1);
});
test('missing JavaScript is named, controls remain inert and controller is not loaded',async()=>{
 const b=await boot({path:'js/capture.js'});assert.equal(b.html.dataset.boot,'failed');assert.match(b.nodes.get('boot-message').textContent,/js\/capture.js/);assert.equal(b.nodes.get('main').inert,true);assert.deepEqual(b.imported,[]);
});
test('old controller bytes are rejected even when the HTML label is current',async()=>{
 const b=await boot({path:'js/phone.js',corrupt:true});assert.equal(b.html.dataset.boot,'failed');assert.match(b.nodes.get('boot-message').textContent,/js\/phone.js.*mixed/);assert.deepEqual(b.imported,[]);
});
test('missing manifest has actionable upload instructions',async()=>{const b=await boot({path:'release-manifest.json'});assert.match(b.nodes.get('boot-message').textContent,/release-manifest.json is missing/);assert.equal(b.html.dataset.boot,'failed');});
test('old manifest is rejected before loading controllers',async()=>{const b=await boot({staleManifest:true});assert.equal(b.html.dataset.boot,'failed');assert.deepEqual(b.imported,[]);});
test('old page cannot use new bootstrap silently',async()=>{const b=await boot({build:'2.1.0'});assert.equal(b.html.dataset.boot,'failed');assert.match(b.nodes.get('boot-message').textContent,/different releases/);});
test('insecure page explains HTTPS instead of leaving a dead camera button',async()=>{const b=await boot({secure:false});assert.equal(b.html.dataset.boot,'failed');assert.match(b.nodes.get('boot-message').textContent,/HTTPS/);});
test('PeerJS CDN error remains actionable and does not load the controller',async()=>{const b=await boot({peerFails:true});assert.equal(b.html.dataset.boot,'failed');assert.match(b.nodes.get('boot-message').textContent,/Peer/);assert.deepEqual(b.imported,[]);});
test('optional QR renderer failure still permits code-based monitor pairing',async()=>{const b=await boot({role:'desktop',qrFails:true});assert.equal(b.html.dataset.boot,'ready');assert.deepEqual(b.imported,['desktop']);});
test('homepage verifies release without requesting external libraries or controller',async()=>{const b=await boot({role:'index'});assert.equal(b.html.dataset.boot,'ready');assert.deepEqual(b.imported,[]);});
