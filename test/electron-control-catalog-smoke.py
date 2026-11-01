#!/usr/bin/env python3
"""Isolated native Electron + CDP verification; never accesses the real notebook instance."""
import asyncio, json, os, subprocess, tempfile, time, urllib.request, urllib.error, signal, socket
from pathlib import Path
import websockets
ROOT=Path(__file__).resolve().parents[1]
ELECTRON=Path('/home/leo/Aplicativos/mcf-dual-browser-cockpit/node_modules/.bin/electron')
with socket.socket() as port_probe:
 port_probe.bind(("127.0.0.1",0))
 PORT=port_probe.getsockname()[1]

async def main():
 with tempfile.TemporaryDirectory(prefix='dualbrowser-catalog-e2e-') as temp:
  home=Path(temp)/'home';home.mkdir();(home/'.config').mkdir();(home/'.cache').mkdir()
  env={**os.environ,'HOME':str(home),'XDG_CONFIG_HOME':str(home/'.config'),'XDG_CACHE_HOME':str(home/'.cache')}
  log=open(Path(temp)/'electron.log','w')
  proc=subprocess.Popen(['xvfb-run','-a','-s','-screen 0 1366x768x24',str(ELECTRON),'.','--instance=catalog-smoke','--remote-debugging-port='+str(PORT),'--no-sandbox','--disable-gpu'],cwd=str(ROOT),env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
  async def evaluate(ws,expression):
   await ws.send(json.dumps({'id':100,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True,'awaitPromise':True}}))
   while True:
    payload=json.loads(await asyncio.wait_for(ws.recv(),timeout=12))
    if payload.get('id')==100:
     if payload.get('result',{}).get('exceptionDetails'):raise RuntimeError('CDP_EVALUATION_EXCEPTION')
     return payload.get('result',{}).get('result',{}).get('value')
  try:
   for _ in range(100):
    if proc.poll() is not None:raise RuntimeError('ELECTRON_EARLY_EXIT')
    try:
     with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list',timeout=.3) as f:targets=json.loads(f.read())
     shell=next((x for x in targets if x.get('title')=='MCF Dual Browser Cockpit' and x.get('type')=='page'),None)
     if shell:break
    except (OSError,ValueError):pass
    await asyncio.sleep(.2)
   else:raise RuntimeError('ELECTRON_SHELL_TIMEOUT')
   async with websockets.connect(shell['webSocketDebuggerUrl'],open_timeout=4,max_size=3_000_000) as ws:
    for _ in range(40):
     ready=await evaluate(ws,'Boolean(window.cockpit && document.getElementById("controlCenterButton"))')
     if ready:break
     await asyncio.sleep(.2)
    assert ready,'PRELOAD_MISSING'
    cat=await evaluate(ws,'window.cockpit.discovery.getCatalog()')
    assert cat['ok'] and cat['catalog']['counts']=={'uiControls':40,'ipcChannels':17,'bridgeRoutes':35},cat.get('catalog',{}).get('counts')
    assert not any(k in json.dumps(cat['catalog']).lower() for k in ['bearer ey','token:','authorization: bearer'])
    assert await evaluate(ws,'window.cockpit.layout.preset("leandro").then(x=>x.splitRatio)')==.65
    assert await evaluate(ws,'window.cockpit.layout.preset("balanced").then(x=>x.splitRatio)')==.5
    await evaluate(ws,'document.getElementById("controlCenterButton").click();true')
    await asyncio.sleep(.3)
    await evaluate(ws,'document.querySelector("[data-control-tab=capabilities]").click();true')
    await asyncio.sleep(.4)
    ui=await evaluate(ws,'({visible:!document.querySelector("[data-control-page=capabilities]").classList.contains("hidden"),status:document.getElementById("catalogStatus").textContent,records:document.getElementById("catalogList").children.length})')
    assert ui['visible'] and ui['records']==92 and '40 controles' in ui['status'],ui
    copy=await evaluate(ws,'window.cockpit.discovery.copyCatalog()')
    assert copy['ok'] and copy['containsCredentials'] is False
    desc=home/'.config/mcf-dual-browser-cockpit/instances/catalog-smoke/agent-bridge.json'
    for _ in range(40):
     if desc.exists():break
     await asyncio.sleep(.1)
    assert desc.exists(),'DESCRIPTOR_MISSING'
    d=json.loads(desc.read_text());assert d['instanceId']=='catalog-smoke'
    if not d['enabled']:
     await evaluate(ws,'window.cockpit.bridge.toggle().then(x=>x.enabled)')
     d=json.loads(desc.read_text())
    base=f'http://127.0.0.1:{d["port"]}/v1/control-catalog'
    try:urllib.request.urlopen(base,timeout=2);raise RuntimeError('UNAUTHENTICATED_ALLOWED')
    except urllib.error.HTTPError as e:assert e.code==401,e.code
    h={'Authorization':'Bearer '+d['token'],'X-MCF-Instance':'catalog-smoke'}
    def live():
     with urllib.request.urlopen(urllib.request.Request(base,headers=h),timeout=5) as f:return json.loads(f.read())
    assert live()['catalog']['counts']['bridgeRoutes']==35
    paused=await evaluate(ws,'window.cockpit.bridge.pause().then(x=>x.paused)')
    assert paused is True
    assert live()['catalog']['runtime']['bridge']['paused'] is True,'CATALOG_MUST_BE_AVAILABLE_WHILE_PAUSED'
    resumed=await evaluate(ws,'window.cockpit.bridge.pause().then(x=>x.paused)')
    assert resumed is False
    cli=subprocess.run(['node',str(ROOT/'bin/mcf-cockpit-discover.mjs'),'--instance=catalog-smoke','--summary'],env=env,capture_output=True,text=True,timeout=10)
    assert cli.returncode==0,(cli.stderr[:200],cli.returncode)
    assert json.loads(cli.stdout)['counts']['uiControls']==40
    print('ELECTRON_E2E_PASS: controls=40 ipc=17 http=35',flush=True)
    print('UI_TAB_VISIBLE_PASS',ui,flush=True)
    print('AUTH_401_AND_200_PASS; PAUSED_GET_200_PASS; RESUMED_PASS',flush=True)
    print('LOCAL_CLI_LIVE_PASS; COPY_SANITIZED_PASS; PRESETS_PASS; ISOLATED_PROFILE_PASS',flush=True)
  finally:
   # xvfb-run is the session leader. Kill the isolated process group, not merely the wrapper.
   try: os.killpg(os.getpgid(proc.pid),signal.SIGTERM)
   except ProcessLookupError: pass
   try:proc.wait(timeout=6)
   except subprocess.TimeoutExpired:
    try:os.killpg(os.getpgid(proc.pid),signal.SIGKILL)
    except ProcessLookupError:pass
    proc.wait(timeout=3)
   log.close()
   tail=(Path(temp)/'electron.log').read_text(errors='replace')[-450:]
   if 'Error: ENOENT' in tail or 'ERR_MODULE_NOT_FOUND' in tail:print('ELECTRON_LOG_FAILURE',tail)

asyncio.run(main())
