import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildControlCatalog,CONTROL_CATALOG_SCHEMA} from '../src/main/control-catalog.mjs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const source=(file)=>readFileSync(path.join(here,'..',file),'utf8');
const catalog=buildControlCatalog();

test('catalog is complete for every declared HTML control and has unique stable selectors',()=>{
  const html=source('src/renderer/index.html');
  const controls=[...html.matchAll(/<(button|input|select|form)\b([^>]*)>/g)]
    .map(m=>({tag:m[1],attrs:m[2]}));
  assert.equal(catalog.uiControls.length,controls.length+1,'also count interactive pointer splitter');
  const selectors=catalog.uiControls.map(x=>x.selector);
  assert.equal(new Set(selectors).size,selectors.length);
  for(const control of controls){
    const attrs=control.attrs;
    const id=attrs.match(/\bid="([^"]+)"/)?.[1];
    let selector=id?`#${id}`:'';
    if(!selector)for(const [key,value] of [...attrs.matchAll(/(data-[\w-]+)="([^"]+)"/g)].map(x=>[x[1],x[2]]))
      if(['data-pane','data-action','data-preset','data-external','data-control-tab','data-open-tab'].includes(key)) selector+=`[${key}="${value}"]`;
    assert(selector,`unidentified element ${control.tag} ${attrs}`);
    assert(selectors.includes(selector),`UI control missing from catalog: ${selector}`);
  }
  assert(catalog.uiControls.some(x=>x.selector==='#toolbarSplitter'));
  assert(!catalog.uiControls.some(x=>x.selector==='#stageDivider'));
});

test('all exposed preload IPC channels have both trusted handler and catalogue entry',()=>{
  const preload=source('src/preload/preload.cjs');const main=source('src/main/main.mjs');
  const exposed=[...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(x=>x[1]);
  const handlers=[...main.matchAll(/handleTrusted\('([^']+)'/g)].map(x=>x[1]);
  assert.deepEqual(new Set(exposed),new Set(handlers));
  assert.deepEqual(new Set(exposed),new Set(catalog.ipcChannels.map(x=>x.channel)));
  assert(catalog.ipcChannels.every(x=>x.httpCallable===false));
  assert(main.includes("event.senderFrame !== mainWindow.webContents.mainFrame"));
});

test('HTTP catalog covers all exact bridge routes and live event aliases',()=>{
  const bridge=source('src/main/bridge.mjs');
  const expected=[...bridge.matchAll(/req\.method === '(GET|POST)'\s*&&\s*requestUrl\.pathname\s*===\s*'([^']+)'/g)]
    .map(x=>`${x[1]} ${x[2]}`);
  for(const route of ['/v1/live/snapshot','/v1/events/snapshot','/v1/live/stream','/v1/events'])expected.push('GET '+route);
  assert.deepEqual(new Set(expected),new Set(catalog.bridgeRoutes.map(x=>`${x.method} ${x.path}`)));
});

test('runtime catalog is sanitized and read-only even when paused, no auth tokens',()=>{
  const token='supersecret-not-for-output';
  const c=buildControlCatalog({bridgeState:{enabled:true,paused:true,busy:false,queueDepth:2,port:47831,token},paneStates:[{pane:'chat',available:true,loading:false}]});
  const json=JSON.stringify(c);
  assert.equal(c.schema,CONTROL_CATALOG_SCHEMA);
  assert.equal(c.runtime.bridge.paused,true);
  assert.equal(c.runtime.bridge.queueDepth,2);
  assert(!json.includes(token));
  assert.equal(c.contract.noGenericExecute,true);
  assert(c.bridgeRoutes.some(x=>x.path==='/v1/control-catalog'&&x.method==='GET'));
});

test('offline CLI outputs same contract without the live browser or user credentials',()=>{
  const out=execFileSync(process.execPath,[path.join(here,'../bin/mcf-cockpit-discover.mjs'),'--offline','--summary'],{encoding:'utf8',timeout:3000});
  const j=JSON.parse(out);
  assert.equal(j.schema,CONTROL_CATALOG_SCHEMA);
  assert.deepEqual(j.counts,catalog.counts);
  assert(!out.includes('Bearer'));
});
