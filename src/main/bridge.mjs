import http from 'node:http';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_BODY = 1024 * 1024;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

function pageSelectorScript() {
  return `(() => {
    const esc = (v) => (globalThis.CSS?.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    const makeSelector = (el) => {
      if (!(el instanceof Element)) return null;
      if (el.id) return '#' + esc(el.id);
      const parts = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
        let part = node.tagName.toLowerCase();
        const stableClasses = [...node.classList].filter(c => c && c.length < 48 && !/^(css-|sc-|jsx-)/.test(c)).slice(0,2);
        if (stableClasses.length) part += '.' + stableClasses.map(esc).join('.');
        const parent = node.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter(x => x.tagName === node.tagName);
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
        }
        parts.unshift(part);
        const candidate = parts.join(' > ');
        try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
        node = parent;
      }
      return parts.join(' > ');
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')]
      .filter(visible)
      .slice(0, 250)
      .map((el, index) => {
        const r = el.getBoundingClientRect();
        return {
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || null,
          role: el.getAttribute('role') || null,
          text: (['INPUT','TEXTAREA','SELECT'].includes(el.tagName) || el.isContentEditable ? '' : (el.innerText || '')).trim().slice(0, 240),
          ariaLabel: el.getAttribute('aria-label'),
          placeholder: el.getAttribute('placeholder'),
          href: el.href || null,
          selector: makeSelector(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
        };
      });
    return { url: location.href, title: document.title, nodes };
  })()`;
}

export class LocalAgentBridge {
  constructor({
    getWorkspaceWebContents,
    captureDir,
    instanceId = 'principal',
    uploadDir = null,
    captureWorkspace = null,
    openAgentSession = null,
    listAgentSessions = null,
    openChatGPTConversation = null,
    getChatGPTConversation = null,
    sendChatGPTMessage = null,
    closeChatGPTConversation = null,
    onEvent = () => {},
  }) {
    this.getWorkspaceWebContents = getWorkspaceWebContents;
    this.captureDir = captureDir;
    this.instanceId = instanceId;
    this.paused = false;
    this.busy = false;
    this.uploadDir = uploadDir;
    this.captureWorkspace = captureWorkspace;
    this.openAgentSession = openAgentSession;
    this.listAgentSessions = listAgentSessions;
    this.openChatGPTConversation = openChatGPTConversation;
    this.getChatGPTConversation = getChatGPTConversation;
    this.sendChatGPTMessage = sendChatGPTMessage;
    this.closeChatGPTConversation = closeChatGPTConversation;
    this.onEvent = onEvent;
    this.server = null;
    this.port = null;
    this.token = randomBytes(24).toString('base64url');
  }

  getState() {
    return {
      enabled: Boolean(this.server),
      instanceId: this.instanceId,
      paused: this.paused,
      busy: this.busy,
      host: '127.0.0.1',
      port: this.port,
      token: this.server ? this.token : null,
    };
  }

  setPaused(paused) {
    this.paused = Boolean(paused);
    this.onEvent({ level: 'info', message: this.paused ? 'Novas ações pausadas; ação em curso pode terminar.' : 'Automação retomada.' });
    return this.getState();
  }

  async start(preferredPort = 47831) {
    if (this.server) return this.getState();

    this.token = randomBytes(24).toString('base64url');
    const server = http.createServer((req, res) => this.#handle(req, res));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.setTimeout(180000, socket => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferredPort, '127.0.0.1', () => resolve());
    }).catch(async (err) => {
      if (err?.code !== 'EADDRINUSE') throw err;
      await new Promise((resolve, reject) => {
        server.removeAllListeners('error');
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
      });
    });

    this.server = server;
    const address = server.address();
    this.port = typeof address === 'object' && address ? address.port : preferredPort;
    this.onEvent({ level: 'ok', message: `Agent Bridge ativo em 127.0.0.1:${this.port}` });
    return this.getState();
  }

  async stop() {
    if (!this.server) return this.getState();
    const server = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    this.onEvent({ level: 'info', message: 'Agent Bridge desativado.' });
    return this.getState();
  }

  async toggle() {
    return this.server ? this.stop() : this.start();
  }

  async #handle(req, res) {
    let acquired = false;
    try {
      if (req.headers.host !== `127.0.0.1:${this.port}` && req.headers.host !== `localhost:${this.port}`) {
        return json(res, 403, { ok: false, error: 'invalid_host' });
      }
      if (req.headers.origin) {
        return json(res, 403, { ok: false, error: 'browser_origin_not_allowed' });
      }

      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && requestUrl.pathname === '/health') {
        return json(res, 200, { ok: true, service: 'mcf-dual-browser-agent-bridge', version: 1 });
      }

      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${this.token}`) {
        return json(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (req.headers['x-mcf-instance'] && req.headers['x-mcf-instance'] !== this.instanceId) {
        return json(res, 409, { ok: false, error: 'instance_mismatch' });
      }
      res.setHeader('x-mcf-instance', this.instanceId);
      if (req.method === 'POST') {
        if (this.paused) return json(res, 423, { ok: false, error: 'automation_paused' });
        if (this.busy) return json(res, 409, { ok: false, error: 'automation_busy' });
        this.busy = true;
        acquired = true;
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/agent-sessions') {
        if (typeof this.listAgentSessions !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_sessions_unavailable' });
        }
        const sessions = await this.listAgentSessions();
        return json(res, 200, { ok: true, sessions });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/agent-session/open') {
        if (typeof this.openAgentSession !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_session_broker_unavailable' });
        }
        const body = await readJson(req);
        const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
        const mission = typeof body.mission === 'string' ? body.mission.trim() : '';
        const objective = typeof body.objective === 'string' ? body.objective.trim() : '';
        if (!agent || agent.length > 80) {
          return json(res, 400, { ok: false, error: 'valid_agent_required' });
        }
        if (mission.length > 160 || objective.length > 1600) {
          return json(res, 400, { ok: false, error: 'agent_session_input_too_large' });
        }
        const result = await this.openAgentSession({
          agent,
          mission: mission || null,
          objective: objective || null,
        });
        return json(res, result?.ok ? 201 : 422, result ?? { ok: false, error: 'agent_session_open_failed' });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/chatgpt/conversation/open') {
        if (typeof this.openChatGPTConversation !== 'function') {
          return json(res, 503, { ok:false, error:'chatgpt_conversation_broker_unavailable' });
        }
        const body = await readJson(req);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        const url = typeof body.url === 'string' ? body.url.trim() : '';
        if (!id || id.length > 160 || title.length > 160 || url.length > 2048) {
          return json(res, 400, { ok:false, error:'valid_conversation_input_required' });
        }
        const result = await this.openChatGPTConversation({ id, title: title || 'Archipelago Chat', url: url || null });
        return json(res, result?.ok ? 201 : 422, result ?? {ok:false,error:'conversation_open_failed'});
      }

      const chatStateMatch = requestUrl.pathname.match(/^\/v1\/chatgpt\/conversation\/([^/]+)$/);
      if (req.method === 'GET' && chatStateMatch) {
        if (typeof this.getChatGPTConversation !== 'function') {
          return json(res, 503, { ok:false, error:'chatgpt_conversation_broker_unavailable' });
        }
        const id = decodeURIComponent(chatStateMatch[1]);
        const conversation = await this.getChatGPTConversation(id);
        return json(res, conversation ? 200 : 404, conversation ? {ok:true,conversation} : {ok:false,error:'conversation_not_found'});
      }

      const sendMatch = requestUrl.pathname.match(/^\/v1\/chatgpt\/conversation\/([^/]+)\/send$/);
      if (req.method === 'POST' && sendMatch) {
        if (typeof this.sendChatGPTMessage !== 'function') {
          return json(res, 503, { ok:false, error:'chatgpt_conversation_broker_unavailable' });
        }
        const body = await readJson(req);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text || text.length > 12000) {
          return json(res, 400, {ok:false,error:'valid_message_required'});
        }
        const result = await this.sendChatGPTMessage({ id:decodeURIComponent(sendMatch[1]), text });
        return json(res, result?.ok ? 200 : 422, result ?? {ok:false,error:'chatgpt_send_failed'});
      }

      const closeMatch = requestUrl.pathname.match(/^\/v1\/chatgpt\/conversation\/([^/]+)\/close$/);
      if (req.method === 'POST' && closeMatch) {
        if (typeof this.closeChatGPTConversation !== 'function') {
          return json(res, 503, { ok:false, error:'chatgpt_conversation_broker_unavailable' });
        }
        const closed = await this.closeChatGPTConversation(decodeURIComponent(closeMatch[1]));
        return json(res, closed ? 200 : 404, closed ? {ok:true} : {ok:false,error:'conversation_not_found'});
      }

      const wc = this.getWorkspaceWebContents();
      if (!wc || wc.isDestroyed()) {
        return json(res, 503, { ok: false, error: 'workspace_unavailable' });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/state') {
        return json(res, 200, {
          ok: true,
          state: {
            instanceId: this.instanceId,
            paused: this.paused,
            busy: this.busy,
            url: wc.getURL(),
            title: wc.getTitle(),
            loading: wc.isLoading(),
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
          },
        });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/text') {
        const text = await wc.executeJavaScript(`(() => ({url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 120000)}))()`, true);
        return json(res, 200, { ok: true, page: text });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/interactive') {
        const page = await wc.executeJavaScript(pageSelectorScript(), true);
        return json(res, 200, { ok: true, page });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/navigate') {
        const body = await readJson(req);
        if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
          return json(res, 400, { ok: false, error: 'http_or_https_url_required' });
        }
        let target;
        try { target = new URL(body.url); } catch { return json(res, 400, { ok: false, error: 'invalid_url' }); }
        if (target.username || target.password) return json(res, 400, { ok: false, error: 'url_credentials_not_allowed' });
        await wc.loadURL(target.href);
        this.onEvent({ level: 'info', message: 'Bridge concluiu navegação.' });
        return json(res, 200, { ok: true, url: wc.getURL() });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/action') {
        const body = await readJson(req);
        const history = wc.navigationHistory;
        if (body.action === 'back' && history.canGoBack()) history.goBack();
        else if (body.action === 'forward' && history.canGoForward()) history.goForward();
        else if (body.action === 'reload') wc.reload();
        else if (body.action === 'stop') wc.stop();
        else return json(res, 400, { ok: false, error: 'invalid_or_unavailable_action' });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/find-click') {
        const body = await readJson(req);
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 240) {
          return json(res, 400, { ok: false, error: 'text_required' });
        }
        const normalizedText = body.text
          .normalize('NFD')
          .replace(/\p{Diacritic}/gu, '')
          .replace(/\s+/g, ' ')
          .trim()
          .toLowerCase();
        if (!normalizedText) {
          return json(res, 400, { ok: false, error: 'text_required' });
        }
        const script = `(() => {
          const needle = ${JSON.stringify(normalizedText)};
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const norm = (value) => String(value || '').normalize('NFD').replace(/\\p{Diacritic}/gu, '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const enabled = (el) =>
            !el.disabled &&
            el.getAttribute('aria-disabled') !== 'true' &&
            !el.hasAttribute('disabled');
          const nodes = [...document.querySelectorAll('a,button,input[type="button"],input[type="submit"],input[type="reset"],input[type="image"],[role="button"],[role="link"],[role="option"],[role="menuitem"],summary')]
            .filter((el) => visible(el) && enabled(el));
          const el = nodes.find((node) => {
            const labels = [
              node.innerText,
              node.value,
              node.getAttribute('aria-label'),
              node.getAttribute('title'),
            ].map(norm).filter(Boolean);
            return labels.some((label) => label.includes(needle));
          });
          if (!el) return {ok:false,error:'not_found'};
          el.scrollIntoView({block:'center',inline:'center'});
          el.focus?.();
          el.click();
          return {ok:true,clicked:true};
        })()`;

        const frames = wc.mainFrame?.framesInSubtree ?? [];
        let framesChecked = 0;
        for (const frame of frames) {
          try {
            framesChecked += 1;
            const result = await frame.executeJavaScript(script, true);
            if (result?.ok) {
              return json(res, 200, { ok: true, clicked: true, framesChecked });
            }
          } catch {}
        }
        return json(res, 404, { ok: false, error: 'not_found', framesChecked });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/click') {
        const body = await readJson(req);
        if (typeof body.selector !== 'string' || body.selector.length > 2000) {
          return json(res, 400, { ok: false, error: 'selector_required' });
        }
        const result = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(body.selector)});
          if (!el) return {ok:false,error:'not_found'};
          el.scrollIntoView({block:'center',inline:'center'});
          el.focus?.();
          el.click();
          return {ok:true};
        })()`, true);
        return json(res, result.ok ? 200 : 404, result);
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/type') {
        const body = await readJson(req);
        if (typeof body.selector !== 'string' || typeof body.text !== 'string') {
          return json(res, 400, { ok: false, error: 'selector_and_text_required' });
        }
        const result = await wc.executeJavaScript(`(() => {
          const el = document.querySelector(${JSON.stringify(body.selector)});
          if (!el) return {ok:false,error:'not_found'};
          el.scrollIntoView({block:'center',inline:'center'});
          el.focus?.();
          const value = ${JSON.stringify(body.text)};
          if (el.isContentEditable) {
            el.textContent = value;
          } else if ('value' in el) {
            const proto = Object.getPrototypeOf(el);
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor?.set) descriptor.set.call(el, value); else el.value = value;
          } else {
            return {ok:false,error:'not_editable'};
          }
          el.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'insertText',data:value}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          if (${Boolean(false)} && el.form) el.form.requestSubmit?.();
          return {ok:true};
        })()`, true);
        return json(res, result.ok ? 200 : 400, result);
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/pointer') {
        const body = await readJson(req);
        if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
          return json(res, 400, { ok: false, error: 'x_y_required' });
        }
        const x = Math.max(0, Math.round(body.x));
        const y = Math.max(0, Math.round(body.y));
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/upload-file') {
        const body = await readJson(req);
        const selector = typeof body.selector === 'string' && body.selector.trim()
          ? body.selector.trim()
          : 'input[type="file"]';
        const buttonText = typeof body.buttonText === 'string' && body.buttonText.trim()
          ? body.buttonText.trim()
          : 'Upload files';
        if (typeof body.file !== 'string' || !body.file.trim()) {
          return json(res, 400, { ok: false, error: 'file_required' });
        }
        if (!this.uploadDir) {
          return json(res, 503, { ok: false, error: 'upload_disabled' });
        }
        if (!existsSync(this.uploadDir) || !existsSync(body.file)) return json(res, 404, { ok: false, error: 'file_not_found' });
        const root = realpathSync(this.uploadDir);
        const file = realpathSync(body.file);
        if (!(file === root || file.startsWith(root + path.sep))) {
          return json(res, 403, { ok: false, error: 'file_not_allowlisted' });
        }
        if (!existsSync(file) || !statSync(file).isFile()) {
          return json(res, 404, { ok: false, error: 'file_not_found' });
        }

        let attachedHere = false;
        try {
          if (!wc.debugger.isAttached()) {
            wc.debugger.attach('1.3');
            attachedHere = true;
          }
          const evaluated = await wc.debugger.sendCommand('Runtime.evaluate', {
            expression: `document.querySelector(${JSON.stringify(selector)})`,
            returnByValue: false,
          });
          const objectId = evaluated?.result?.subtype === 'null'
            ? null
            : evaluated?.result?.objectId;
          if (objectId) {
            await wc.debugger.sendCommand('DOM.setFileInputFiles', {
              objectId,
              files: [file],
            });
          } else {
            await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
            const backendNodeId = await new Promise((resolve, reject) => {
              let settled = false;
              const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                wc.debugger.removeListener('message', onMessage);
                fn(value);
              };
              const onMessage = (_event, method, params) => {
                if (method === 'Page.fileChooserOpened' && params?.backendNodeId) {
                  finish(resolve, params.backendNodeId);
                }
              };
              const timer = setTimeout(() => finish(reject, new Error('file_chooser_timeout')), 6000);
              wc.debugger.on('message', onMessage);
              const clickScript = `(() => {
                const norm = (v) => String(v || '').normalize('NFD').replace(/\\p{Diacritic}/gu, '').replace(/\\s+/g, ' ').trim().toLowerCase();
                const needle = norm(${JSON.stringify(buttonText)});
                const el = [...document.querySelectorAll('button,[role="button"]')]
                  .find((node) => norm(node.innerText || node.getAttribute('aria-label') || '').includes(needle));
                if (!el) return false;
                el.click();
                return true;
              })()`;
              wc.executeJavaScript(clickScript, true)
                .then((clicked) => { if (!clicked) finish(reject, new Error('upload_button_not_found')); })
                .catch((error) => finish(reject, error));
            });
            await wc.debugger.sendCommand('DOM.setFileInputFiles', {
              backendNodeId,
              files: [file],
            });
          }
          this.onEvent({ level: 'ok', message: `Bridge anexou arquivo aprovado: ${path.basename(file)}` });
          return json(res, 200, { ok: true, filename: path.basename(file) });
        } finally {
          if (wc.debugger.isAttached()) {
            try { await wc.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }); } catch {}
          }
          if (attachedHere && wc.debugger.isAttached()) {
            try { wc.debugger.detach(); } catch {}
          }
        }
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/capture') {
        if (typeof this.captureWorkspace === 'function') {
          const result = await this.captureWorkspace();
          return json(res, result?.ok ? 200 : 500, result ?? { ok: false, error: 'capture_failed' });
        }
        mkdirSync(this.captureDir, { recursive: true });
        const image = await wc.capturePage();
        const filename = `workspace-${Date.now()}.png`;
        const output = path.join(this.captureDir, filename);
        writeFileSync(output, image.toPNG(), { mode: 0o600, flag: 'wx' });
        return json(res, 200, { ok: true, path: output });
      }

      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      const code = error.message === 'invalid_json' ? 'invalid_json' : 'internal_error';
      this.onEvent({ level: 'error', message: `Bridge: ${code}` });
      if (!res.destroyed) return json(res, code === 'invalid_json' ? 400 : 500, { ok: false, error: code });
    } finally {
      if (acquired) this.busy = false;
    }
  }
}
