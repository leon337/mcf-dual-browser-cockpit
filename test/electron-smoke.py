import os, subprocess, tempfile, time, json, urllib.request, pathlib, signal
root=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='mcf-smoke-') as tmp:
    env=dict(os.environ, XDG_CONFIG_HOME=tmp)
    processes=[]
    def launch(name):
        log=open(pathlib.Path(tmp)/(name+str(len(processes))+'.log'),'w')
        p=subprocess.Popen(([os.environ['MCF_TEST_BINARY']] if os.environ.get('MCF_TEST_BINARY') else [str(root/'node_modules/electron/dist/electron'),str(root)])+['--instance='+name],env=env,stdout=log,stderr=log,start_new_session=True)
        processes.append(p)
        return p
    def descriptor(name):
        target=pathlib.Path(tmp)/'mcf-dual-browser-cockpit/instances'/name/'agent-bridge.json'
        for _ in range(150):
            if target.exists():
                data=json.loads(target.read_text())
                if data.get('enabled'): return data
            time.sleep(.2)
        raise RuntimeError('bridge not ready: '+name)
    def call(d, route, body=None):
        req=urllib.request.Request('http://127.0.0.1:'+str(d['port'])+route,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+d['token'],'X-MCF-Instance':d['instanceId']})
        return json.load(urllib.request.urlopen(req,timeout=15))
    try:
        a=launch('smoke-a'); da=descriptor('smoke-a')
        b=launch('smoke-b'); db=descriptor('smoke-b')
        assert da['port'] != db['port'] and da['token'] != db['token']
        assert call(da,'/v1/state')['state']['instanceId']=='smoke-a'
        assert call(db,'/v1/state')['state']['instanceId']=='smoke-b'
        duplicate=launch('smoke-a'); assert duplicate.wait(timeout=15)==0
        assert a.poll() is None and b.poll() is None
        # Local deterministic fixture, no reliance on public network.
        from http.server import HTTPServer, BaseHTTPRequestHandler
        from threading import Thread
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'<title>MCF smoke fixture</title><input type="password" value="SECRET"><button>Teste</button>')
            def log_message(self,*args): pass
        server=HTTPServer(('127.0.0.1',0),Handler); Thread(target=server.serve_forever,daemon=True).start()
        target='http://127.0.0.1:'+str(server.server_port)+'/instance-a'
        call(da,'/v1/navigate',{'url':target})
        assert 'SECRET' not in json.dumps(call(da,'/v1/interactive'))
        time.sleep(.8)
        state=pathlib.Path(tmp)/'mcf-dual-browser-cockpit/instances/smoke-a/runtime-state.json'
        assert json.loads(state.read_text())['workspace']['url']==target
        os.killpg(a.pid,signal.SIGTERM); a.wait(timeout=15)
        a2=launch('smoke-a'); time.sleep(1); da2=descriptor('smoke-a')
        assert da2['pid'] != da['pid']
        for _ in range(50):
            if call(da2,'/v1/state')['state']['url']==target: break
            time.sleep(.2)
        else: raise AssertionError('session did not restore')
        assert call(db,'/v1/state')['state']['instanceId']=='smoke-b'
        print('PASS: two real Electron profiles, distinct bridges, duplicate lock, password redaction, persistence, restart restoration.')
        server.shutdown()
    finally:
        for log in pathlib.Path(tmp).glob('*.log'):
            content=log.read_text()
            if 'Error' in content: print(log.name, content[-1800:])
        for p in processes:
            if p.poll() is None:
                os.killpg(p.pid,signal.SIGTERM)
                try: p.wait(timeout=10)
                except subprocess.TimeoutExpired: os.killpg(p.pid,signal.SIGKILL)
