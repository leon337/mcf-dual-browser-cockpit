import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
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
          text: (el.innerText || el.value || '').trim().slice(0, 240),
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
  constructor({ getWorkspaceWebContents, captureDir, captureWorkspace = null, onEvent = () => {} }) {
    this.getWorkspaceWebContents = getWorkspaceWebContents;
    this.captureDir = captureDir;
    this.captureWorkspace = captureWorkspace;
    this.onEvent = onEvent;
    this.server = null;
    this.port = null;
    this.token = randomBytes(24).toString('base64url');
  }

  getState() {
    return {
      enabled: Boolean(this.server),
      host: '127.0.0.1',
      port: this.port,
      token: this.server ? this.token : null,
    };
  }

  async start(preferredPort = 47831) {
    if (this.server) return this.getState();

    const server = http.createServer((req, res) => this.#handle(req, res));
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
    await new Promise((resolve) => server.close(() => resolve()));
    this.onEvent({ level: 'info', message: 'Agent Bridge desativado.' });
    return this.getState();
  }

  async toggle() {
    return this.server ? this.stop() : this.start();
  }

  async #handle(req, res) {
    try {
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

      const wc = this.getWorkspaceWebContents();
      if (!wc || wc.isDestroyed()) {
        return json(res, 503, { ok: false, error: 'workspace_unavailable' });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/state') {
        return json(res, 200, {
          ok: true,
          state: {
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
        await wc.loadURL(body.url);
        this.onEvent({ level: 'info', message: `Bridge navegou para ${body.url}` });
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
        const script = `(() => {
          const needle = ${JSON.stringify(body.text)}.normalize('NFD').replace(/\\p{Diacritic}/gu, '').trim().toLowerCase();
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
          };
          const norm = (value) => String(value || '').normalize('NFD').replace(/\\p{Diacritic}/gu, '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const nodes = [...document.querySelectorAll('a,button,[role="button"],[role="link"],[role="option"],[role="menuitem"],summary')].filter(visible);
          const el = nodes.find((node) => {
            const hay = norm(node.innerText || node.getAttribute('aria-label') || node.getAttribute('title') || '');
            return hay.includes(needle);
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

      if (req.method === 'POST' && requestUrl.pathname === '/v1/capture') {
        mkdirSync(this.captureDir, { recursive: true });
        const image = await wc.capturePage();
        const filename = `workspace-${Date.now()}.png`;
        const output = path.join(this.captureDir, filename);
        writeFileSync(output, image.toPNG());
        return json(res, 200, { ok: true, path: output });
      }

      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      this.onEvent({ level: 'error', message: `Bridge: ${error.message}` });
      return json(res, 500, { ok: false, error: 'internal_error', detail: error.message });
    }
  }
}
