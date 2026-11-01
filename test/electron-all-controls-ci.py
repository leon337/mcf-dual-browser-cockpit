#!/usr/bin/env python3
"""Isolated 40-control acceptance test. No real accounts or production profile."""
import asyncio, json, os, signal, socket, subprocess, tempfile, time, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
import websockets

ROOT = Path(__file__).resolve().parents[1]
CATALOG = json.loads((ROOT / "capabilities/control-catalog.v1.json").read_text())
OUT = ROOT / "qa-artifacts"
OUT.mkdir(exist_ok=True)
RESULTS = {}
DISPLAY = None

def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        page = self.path.split("?", 1)[0].strip("/") or "index"
        data = (f"<!doctype html><title>Fixture {page}</title><main data-fixture='{page}'>"
                f"Local fixture {page}<a href='/a'>A</a><a href='/b'>B</a></main>").encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

class CDP:
    def __init__(self, ws):
        self.ws, self.n = ws, 100
    async def cmd(self, method, params=None):
        self.n += 1
        seq = self.n
        await self.ws.send(json.dumps({"id": seq, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await asyncio.wait_for(self.ws.recv(), 12))
            if message.get("id") == seq:
                if message.get("error"):
                    raise RuntimeError("CDP method failed: " + method)
                return message["result"]
    async def js(self, expression):
        data = await self.cmd("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True})
        if "exceptionDetails" in data:
            raise RuntimeError("renderer evaluation failed")
        return data.get("result", {}).get("value")
    async def click(self, selector):
        js = """(() => {const el=document.querySelector(%s);
          if(!el || el.disabled) return null;
          const r=el.getBoundingClientRect();
          if(r.width<2||r.height<2 || getComputedStyle(el).visibility==='hidden')return null;
          return {x:r.x+r.width/2,y:r.y+r.height/2};})()""" % json.dumps(selector)
        loc = await self.js(js)
        if not loc:
            raise AssertionError("control missing, disabled, hidden or zero-size: " + selector)
        for method, params in [
            ("mouseMoved", {"x":loc["x"], "y":loc["y"]}),
            ("mousePressed", {"x":loc["x"], "y":loc["y"], "button":"left","clickCount":1}),
            ("mouseReleased", {"x":loc["x"], "y":loc["y"], "button":"left","clickCount":1}),
        ]:
            await self.cmd("Input.dispatchMouseEvent", {"type":method, **params})
    async def set_value(self, selector, value):
        expression = """(() => {let el=document.querySelector(%s);
          if(!el)return false;
          if(el.type==='checkbox') el.checked=%s;
          else el.value=%s;
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
          return true;})()""" % (json.dumps(selector), json.dumps(bool(value)),
                                  json.dumps(str(value)))
        assert await self.js(expression)
    async def state(self):
        return await self.js("window.cockpit.browser.getStates()")
    async def bridge(self):
        return await self.js("window.cockpit.bridge.getState()")
    async def settings(self):
        return await self.js("window.cockpit.settings.get()")

async def eventually(fn, seconds=5):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        try:
            value = await fn()
            if value:
                return value
        except (OSError, AssertionError, RuntimeError):
            pass
        await asyncio.sleep(.12)
    return None

def run_record(selector, outcome, detail):
    if selector in RESULTS:
        raise AssertionError("duplicate result: " + selector)
    RESULTS[selector] = {"status": outcome, "evidence": str(detail)[:250]}
    print("CONTROL", len(RESULTS), outcome, selector, flush=True)

async def tested(selector, operation):
    try:
        evidence = await operation()
        if evidence is False or evidence is None:
            raise AssertionError("missing observed result")
        run_record(selector, "PASS", evidence)
    except Exception as exc:
        run_record(selector, "FAIL", type(exc).__name__ + ": " + str(exc)[:150])

async def main():
    with tempfile.TemporaryDirectory(prefix="mcf-40-controls-") as tmp:
        sandbox = Path(tmp)
        home = sandbox / "home"
        for sub in (".config", ".cache", ".local/share", "Pictures"):
            (home / sub).mkdir(parents=True, exist_ok=True)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Fixture)
        Thread(target=server.serve_forever, daemon=True).start()
        fixture = f"http://127.0.0.1:{server.server_port}"
        cdp_port = free_port()
        record_file = sandbox / "external-opened.txt"
        display_file = sandbox / "display.txt"
        fake_bin = sandbox / "bin"
        fake_bin.mkdir()
        opener = fake_bin / "xdg-open"
        opener.write_text("#!/bin/sh\nprintf '%s\\n' \"$1\" >> \"$MCF_OPENER_LOG\"\n")
        opener.chmod(0o755)
        env = {**os.environ, "HOME":str(home), "XDG_CONFIG_HOME":str(home/".config"),
               "XDG_CACHE_HOME":str(home/".cache"),"XDG_DATA_HOME":str(home/".local/share"),
               "PATH":str(fake_bin)+os.pathsep+os.environ.get("PATH",""),
               "BROWSER":str(opener),"MCF_OPENER_LOG":str(record_file),
               "MCF_DISPLAY_FILE":str(display_file)}
        logfile = (OUT / "electron-qa.log").open("w")
        electron = ROOT/"node_modules/.bin/electron"
        process = subprocess.Popen(
            ["xvfb-run","-a","-s","-screen 0 1366x768x24","sh","-c",
             'printf "%s" "$DISPLAY" > "$MCF_DISPLAY_FILE"; exec "$@"',
             "mcf-qa",str(electron),".","--instance=qa-controls",
             "--remote-debugging-port="+str(cdp_port),"--no-sandbox","--disable-gpu"],
            cwd=ROOT, env=env, stdout=logfile, stderr=subprocess.STDOUT,
            start_new_session=True)
        try:
            async def get_shell():
                with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/list",timeout=1) as req:
                    targets=json.loads(req.read())
                return next((t for t in targets if t.get("type")=="page"
                             and t.get("title")=="MCF Dual Browser Cockpit"),None)
            shell = await eventually(get_shell, 20)
            assert shell, "Electron shell not found"
            global DISPLAY
            DISPLAY = display_file.read_text() if display_file.exists() else None
            assert DISPLAY and DISPLAY.startswith(":")
            async with websockets.connect(shell["webSocketDebuggerUrl"],open_timeout=4,max_size=3000000) as ws:
                c = CDP(ws)
                assert await eventually(lambda:c.js("Boolean(window.cockpit?.discovery)"))
                descriptor = home/".config/mcf-dual-browser-cockpit/instances/qa-controls/agent-bridge.json"
                assert await eventually(lambda:asyncio.sleep(0,result=descriptor.exists()))
                assert not (home/".config/mcf-dual-browser-cockpit/instances/notebook").exists()
                d = json.loads(descriptor.read_text())
                assert d["instanceId"]=="qa-controls"
                async def url(pane):
                    return (await c.state())[pane]["url"]
                async def go(pane, page):
                    target=fixture+"/"+page
                    result=await c.js("window.cockpit.browser.navigate(%s,%s)"%(json.dumps(pane),json.dumps(target)))
                    assert result["ok"]
                    assert await eventually(lambda: url(pane)==target)
                async def show(tab):
                    if await c.js('document.getElementById("controlCenter").classList.contains("hidden")'):
                        await c.click("#controlCenterButton")
                    await c.click('[data-control-tab="'+tab+'"]')
                    assert await eventually(lambda:c.js('!document.querySelector("[data-control-page='+tab+']").classList.contains("hidden")'))
                async def close():
                    if not await c.js('document.getElementById("controlCenter").classList.contains("hidden")'):
                        await c.click("#closeControlCenter")
                        assert await eventually(lambda:c.js('document.getElementById("controlCenter").classList.contains("hidden")'))
                async def ratio_step(preset, expected):
                    await close()
                    await c.click('[data-preset="'+preset+'"]')
                    actual=(await c.state())["splitRatio"]
                    assert abs(actual-expected)<0.002, actual
                    return "ratio="+str(actual)
                for preset,expected in (("leandro",.65),("balanced",.5),("mestre",.35)):
                    await tested('[data-preset="'+preset+'"]',lambda p=preset,e=expected:ratio_step(p,e))
                async def open_control():
                    await c.click("#controlCenterButton")
                    assert await eventually(lambda:c.js('!document.getElementById("controlCenter").classList.contains("hidden")'))
                    return "control-center visible"
                await tested("#controlCenterButton",open_control)
                await close()
                async def toggle_bridge():
                    original=(await c.bridge())["enabled"]
                    await c.click("#bridgeButton")
                    async def changed():return (await c.bridge())["enabled"]!=original
                    assert await eventually(changed)
                    if not (await c.bridge())["enabled"]:
                        await c.click("#bridgeButton")
                        assert await eventually(lambda:c.js("window.cockpit.bridge.getState().then(x=>x.enabled)"))
                    return "enabled flipped and restored"
                await tested("#bridgeButton",toggle_bridge)
                async def pause_toolbar():
                    assert (await c.bridge())["enabled"]
                    await c.click("#pauseBridgeButton")
                    assert await eventually(lambda:c.js("window.cockpit.bridge.getState().then(x=>x.paused)"))
                    await c.click("#pauseBridgeButton")
                    assert await eventually(lambda:c.js("window.cockpit.bridge.getState().then(x=>!x.paused)"))
                    return "paused=true then false"
                await tested("#pauseBridgeButton",pause_toolbar)
                def clipboard():
                    response = subprocess.run(["xclip","-selection","clipboard","-o"],
                                              env={**env,"DISPLAY":DISPLAY},capture_output=True,timeout=3)
                    if response.returncode!=0:raise AssertionError("clipboard unavailable")
                    return response.stdout.decode("utf-8",errors="replace")
                async def copy_token():
                    await c.click("#copyTokenButton")
                    assert await eventually(lambda:asyncio.sleep(0,result=clipboard()==json.loads(descriptor.read_text())["token"]))
                    return "isolated clipboard matches ephemeral token; value not logged"
                await tested("#copyTokenButton",copy_token)
                async def navigate_action(pane,action):
                    if action in ("back","forward","reload"):
                        await go(pane,"a");await go(pane,"b")
                        await c.click('[data-pane="'+pane+'"][data-action="'+action+'"]')
                        expected="a" if action=="back" else "b"
                        assert await eventually(lambda:url(pane)==fixture+"/"+expected)
                        return action+" fixture path=/"+expected
                    if action=="home":
                        await go(pane,"a")
                        await c.click('[data-pane="'+pane+'"][data-action="home"]')
                        expected="chatgpt.com" if pane=="chat" else "google.com"
                        assert await eventually(lambda:asyncio.sleep(0,result=expected in str((await url(pane)))))
                        return "home URL family verified"
                    if action=="devtools":
                        await go(pane,"a")
                        await c.click('[data-pane="'+pane+'"][data-action="devtools"]')
                        async def has_devtools():
                            with urllib.request.urlopen(f"http://127.0.0.1:{cdp_port}/json/list",timeout=1) as req:
                                pages=json.loads(req.read())
                            return any("DevTools" in (t.get("title") or "") for t in pages)
                        assert await eventually(has_devtools)
                        return "DevTools target observed"
                for pane in ("chat","workspace"):
                    for action in ("back","forward","reload","home","devtools"):
                        sel='[data-pane="'+pane+'"][data-action="'+action+'"]'
                        await tested(sel,lambda p=pane,a=action:navigate_action(p,a))
                    async def external(p=pane):
                        await go(p,"a")
                        before=record_file.read_text() if record_file.exists() else ""
                        await c.click('[data-external="'+p+'"]')
                        assert await eventually(lambda:asyncio.sleep(0,result=record_file.exists() and fixture+"/a" in record_file.read_text()[len(before):]))
                        return "stub external opener received only local fixture URL"
                    await tested('[data-external="'+pane+'"]',external)
                async def splitter():
                    await close()
                    old=(await c.state())["splitRatio"]
                    pt=await c.js('''(() => {const r=document.getElementById("toolbarSplitter").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()''')
                    await c.cmd("Input.dispatchMouseEvent",{"type":"mouseMoved",**pt})
                    await c.cmd("Input.dispatchMouseEvent",{"type":"mousePressed",**pt,"button":"left","clickCount":1})
                    await c.cmd("Input.dispatchMouseEvent",{"type":"mouseMoved","x":pt["x"]+120,"y":pt["y"],"buttons":1})
                    await c.cmd("Input.dispatchMouseEvent",{"type":"mouseReleased","x":pt["x"]+120,"y":pt["y"],"button":"left","clickCount":1})
                    async def changed():return abs((await c.state())["splitRatio"]-old)>.02
                    assert await eventually(changed)
                    return "pointer moved splitRatio"
                await tested("#toolbarSplitter",splitter)
                async def address():
                    await go("workspace","a")
                    await c.set_value("#workspaceAddress",fixture+"/b")
                    assert await c.js('document.getElementById("workspaceAddress").value')==fixture+"/b"
                    assert await url("workspace")==fixture+"/a"
                    return "typed local URL without unintended navigation"
                await tested("#workspaceAddress",address)
                async def go_button():
                    await c.click("#goButton")
                    assert await eventually(lambda:url("workspace")==fixture+"/b")
                    return "clicked IR and fixture URL changed"
                await tested("#goButton",go_button)
                async def capture():
                    await c.click("#captureButton")
                    pictures=home/"Pictures/MCF-Cockpit-Captures"
                    async def pngs():return list(pictures.glob("*.png")) if pictures.exists() else []
                    paths=await eventually(pngs)
                    assert paths and paths[0].read_bytes().startswith(bytes.fromhex("89504e470d0a1a0a"))
                    assert paths[0].stat().st_mode&0o777==0o600
                    return "isolated PNG created with mode 0600"
                await tested("#captureButton",capture)
                async def tab_action(tab):
                    await show(tab)
                    return "visible tab "+tab
                for tab in ("overview","observability","settings"):
                    await tested('[data-control-tab="'+tab+'"]',lambda t=tab:tab_action(t))
                async def refresh():
                    await show("overview")
                    await c.click("#refreshControlButton")
                    async def updated():
                        val=await c.js('document.getElementById("lastRefresh").textContent')
                        return val and val!="Aguardando leitura" and val!="Leitura indisponível"
                    assert await eventually(updated)
                    return "observability refresh timestamp present"
                await tested("#refreshControlButton",refresh)
                async def close_action():
                    await show("overview")
                    await c.click("#closeControlCenter")
                    assert await eventually(lambda:c.js('document.getElementById("controlCenter").classList.contains("hidden")'))
                    return "control-center closed"
                await tested("#closeControlCenter",close_action)
                async def see_all():
                    await show("overview")
                    await c.click('[data-open-tab="observability"]')
                    assert await eventually(lambda:c.js('!document.querySelector("[data-control-page=observability]").classList.contains("hidden")'))
                    return "navigated to observability"
                await tested('[data-open-tab="observability"]',see_all)
                async def settings_pause():
                    await show("settings")
                    await c.click("#settingsAutomationToggle")
                    assert await eventually(lambda:c.js("window.cockpit.bridge.getState().then(x=>x.paused)"))
                    await c.click("#settingsAutomationToggle")
                    assert await eventually(lambda:c.js("window.cockpit.bridge.getState().then(x=>!x.paused)"))
                    return "settings pause & resume verified"
                await tested("#settingsAutomationToggle",settings_pause)
                for selector,value in (("#settingsStartBridge",False),("#settingsPort",51771),
                                       ("#settingsLayout","leandro"),("#settingsRefresh","5000"),
                                       ("#settingsEventLimit","50")):
                    async def field(sel=selector,v=value):
                        await show("settings")
                        await c.set_value(sel,v)
                        value=await c.js('''(() => {const e=document.querySelector(%s);return e.type==='checkbox'?e.checked:e.value})()'''%json.dumps(sel))
                        assert value==(v if isinstance(v,bool) else str(v))
                        return "form value verified"
                    await tested(selector,field)
                async def save_form(button):
                    await show("settings")
                    if button:
                        await c.click("#saveSettingsButton")
                    else:
                        await c.js('document.getElementById("settingsForm").requestSubmit();true')
                    async def persisted():
                        data=await c.settings()
                        s=data.get("settings",{})
                        return s.get("preferredBridgePort")==51771 and s.get("eventLimit")==50 and s.get("defaultLayout")=="leandro"
                    assert await eventually(persisted)
                    settings_file=home/".config/mcf-dual-browser-cockpit/instances/qa-controls/control-settings.json"
                    assert settings_file.exists()
                    return "validated local settings persisted to sandbox"
                await tested("#saveSettingsButton",lambda:save_form(True))
                await tested("#settingsForm",lambda:save_form(False))
                await tested('[data-control-tab="capabilities"]',lambda:tab_action("capabilities"))
                async def catalog_refresh():
                    await show("capabilities")
                    await c.click("#catalogRefresh")
                    async def good():
                        return (await c.js('document.getElementById("catalogList").children.length'))==92
                    assert await eventually(good)
                    return "92 catalog rows refreshed"
                await tested("#catalogRefresh",catalog_refresh)
                async def catalog_copy():
                    await show("capabilities")
                    await c.click("#catalogCopy")
                    parsed=json.loads(clipboard())
                    assert parsed["counts"]=={"uiControls":40,"ipcChannels":17,"bridgeRoutes":35}
                    assert d["token"] not in json.dumps(parsed)
                    return "clipboard JSON sanitized and 92 mechanisms"
                await tested("#catalogCopy",catalog_copy)
                # Assert all declared selectors were exercised with an independent result.
                expected={item["selector"] for item in CATALOG["uiControls"]}
                assert len(expected)==40
                assert set(RESULTS)==expected, "missing/extra selectors"
        finally:
            try: os.killpg(os.getpgid(process.pid),signal.SIGTERM)
            except ProcessLookupError: pass
            try:process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:os.killpg(os.getpgid(process.pid),signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=3)
            logfile.close()
            server.shutdown()

if __name__=="__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        print("HARNESS_FAILURE",type(e).__name__,str(e)[:180],flush=True)
    finally:
        expected={item["selector"] for item in CATALOG["uiControls"]}
        for selector in sorted(expected-set(RESULTS)):
            run_record(selector,"BLOCKED","harness did not reach this control")
        summary={"schema":"mcf-cockpit-e2e-controls/v1","controls":len(expected),
                 "passed":sum(x["status"]=="PASS" for x in RESULTS.values()),
                 "failed":sum(x["status"]=="FAIL" for x in RESULTS.values()),
                 "blocked":sum(x["status"]=="BLOCKED" for x in RESULTS.values()),
                 "results":[{"selector":k,**v} for k,v in sorted(RESULTS.items())]}
        (OUT/"controls-e2e.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2)+"\n")
        print("RESULT",summary["passed"],"/",summary["controls"],
              "FAIL",summary["failed"],"BLOCKED",summary["blocked"],flush=True)
    if summary["passed"]!=40:
        raise SystemExit(1)
