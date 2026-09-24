import http from 'node:http';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const MAX_BODY = 1024 * 1024;
const MAX_MESSAGE = 16000;

function normalizePaneTarget(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (['chat', 'emilly', 'emily'].includes(key)) return 'chat';
  if (['workspace', 'sophia', 'sofia'].includes(key)) return 'workspace';
  return null;
}

function messageInput(body) {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > MAX_MESSAGE) return null;
  return message;
}


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
    getPaneWebContents = null,
    captureDir,
    instanceId = 'principal',
    uploadDir = null,
    captureWorkspace = null,
    openAgentSession = null,
    listAgentSessions = null,
    getAgentIdentities = null,
    bootstrapAgentIdentities = null,
    dispatchAgentMission = null,
    listAgentReceipts = null,
    listAgentMissions = null,
    getAgentMission = null,
    getParentAgentMissionStatus = null,
    onEvent = () => {},
  }) {
    this.getWorkspaceWebContents = getWorkspaceWebContents;
    this.getPaneWebContents = typeof getPaneWebContents === 'function'
      ? getPaneWebContents
      : (pane) => pane === 'workspace' ? this.getWorkspaceWebContents?.() : null;
    this.captureDir = captureDir;
    this.instanceId = instanceId;
    this.paused = false;
    this.busy = false;
    this.uploadDir = uploadDir;
    this.captureWorkspace = captureWorkspace;
    this.openAgentSession = openAgentSession;
    this.listAgentSessions = listAgentSessions;
    this.getAgentIdentities = getAgentIdentities;
    this.bootstrapAgentIdentities = bootstrapAgentIdentities;
    this.dispatchAgentMission = dispatchAgentMission;
    this.listAgentReceipts = listAgentReceipts;
    this.listAgentMissions = listAgentMissions;
    this.getAgentMission = getAgentMission;
    this.getParentAgentMissionStatus = getParentAgentMissionStatus;
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
    server.setTimeout(30000, socket => socket.destroy());
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

  #paneWebContents(target) {
    const pane = normalizePaneTarget(target);
    if (!pane) return { pane: null, wc: null };
    const wc = this.getPaneWebContents?.(pane) ?? null;
    if (!wc || wc.isDestroyed?.()) return { pane, wc: null };
    return { pane, wc };
  }

  #automationTarget(value) {
    const requested = value == null || value === '' ? 'workspace' : value;
    const pane = normalizePaneTarget(requested);
    if (!pane) return { ok: false, status: 400, error: 'valid_pane_required' };
    const { wc } = this.#paneWebContents(pane);
    if (!wc) return { ok: false, status: 503, error: 'pane_unavailable', pane };
    return { ok: true, pane, wc };
  }

  async sendMessage(target, message) {
    const pane = normalizePaneTarget(target);
    const normalizedMessage = messageInput({ message });
    if (!pane) return { ok: false, error: 'valid_message_target_required' };
    if (!normalizedMessage) return { ok: false, error: 'valid_message_required' };
    return this.#sendMessage(pane, normalizedMessage);
  }

  async #cleanupComposerDraft(wc) {
    if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') {
      return { ok: false, cleaned: false, error: 'draft_cleanup_target_unavailable' };
    }

    const result = await wc.executeJavaScript(`(async () => {
      const MCF_DRAFT_CLEANUP = true;
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const findComposer = () => document.querySelector('#prompt-textarea')
        || document.querySelector('textarea')
        || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
      const composer = findComposer();
      if (!composer) return { ok:true, cleaned:true, remainingLength:0, absent:true };

      const readText = () => String(
        composer.innerText
        || composer.value
        || composer.textContent
        || ''
      ).trim();

      try {
        composer.focus();
        if (composer.isContentEditable) {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          selection.removeAllRanges();
          selection.addRange(range);
          try { document.execCommand('delete', false); } catch {}
          if (readText()) {
            composer.replaceChildren();
            composer.dispatchEvent(new InputEvent('input', {
              bubbles: true,
              inputType: 'deleteContentBackward',
              data: null,
            }));
          }
        } else if ('value' in composer) {
          const proto = Object.getPrototypeOf(composer);
          const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
          if (descriptor?.set) descriptor.set.call(composer, '');
          else composer.value = '';
          composer.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            inputType: 'deleteContentBackward',
            data: null,
          }));
          composer.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (error) {
        return {
          ok:false,
          cleaned:false,
          error:String(error?.message || error),
          remainingLength:readText().length,
        };
      }

      await new Promise(resolve => setTimeout(resolve, 80));
      const remainingLength = readText().length;
      return {
        ok: remainingLength === 0,
        cleaned: remainingLength === 0,
        remainingLength,
      };
    })()`, true).catch(error => ({
      ok: false,
      cleaned: false,
      error: String(error?.message || error),
    }));

    return result ?? { ok: false, cleaned: false, error: 'draft_cleanup_failed' };
  }

  async #sendMessage(target, message) {
    const { pane, wc } = this.#paneWebContents(target);
    if (!pane) return { ok: false, error: 'invalid_message_target' };
    if (!wc) return { ok: false, pane, error: 'message_target_unavailable' };
    if (typeof wc.executeJavaScript !== 'function' || typeof wc.insertText !== 'function') {
      return { ok: false, pane, error: 'message_transport_unavailable' };
    }

    const prepared = await wc.executeJavaScript(`(async () => {
      const enforceChatMode = ${pane === 'chat' ? 'true' : 'false'};
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const userMessages = [...document.querySelectorAll('[data-message-author-role="user"]')];
      const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const baseline = {
        url: location.href,
        userMessageCount: userMessages.length,
        lastUserMessageId: userMessages.at(-1)?.getAttribute('data-message-id') || null,
        lastAssistantMessageId: assistantMessages.at(-1)?.getAttribute('data-message-id') || null,
      };
      const findComposer = () => document.querySelector('#prompt-textarea')
        || document.querySelector('textarea')
        || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
      const findModeButton = (label) => [...document.querySelectorAll('button[role="radio"]')]
        .filter(visible)
        .find(button => String(button.innerText || button.textContent || '').trim() === label);

      if (enforceChatMode) {
        let chatMode = findModeButton('Chat');
        let workMode = findModeButton('Work');
        const currentSend = document.querySelector('[data-testid="send-button"]');
        const composerBefore = findComposer();
        const chatOn = chatMode?.getAttribute('data-state') === 'on'
          || chatMode?.getAttribute('aria-checked') === 'true'
          || chatMode?.getAttribute('aria-selected') === 'true';
        const workOn = workMode?.getAttribute('data-state') === 'on'
          || workMode?.getAttribute('aria-checked') === 'true'
          || workMode?.getAttribute('aria-selected') === 'true';
        const blocked = currentSend?.getAttribute('aria-disabled') === 'true'
          || currentSend?.disabled === true;
        const needsSwitch = Boolean(chatMode) && (!chatOn || workOn || !composerBefore || blocked);

        if (needsSwitch) {
          chatMode.click();
          await new Promise(resolve => setTimeout(resolve, 900));
          chatMode = findModeButton('Chat');
          workMode = findModeButton('Work');
          const refreshedComposer = findComposer();
          const refreshedChatOn = chatMode?.getAttribute('data-state') === 'on'
            || chatMode?.getAttribute('aria-checked') === 'true'
            || chatMode?.getAttribute('aria-selected') === 'true';
          const refreshedWorkOn = workMode?.getAttribute('data-state') === 'on'
            || workMode?.getAttribute('aria-checked') === 'true'
            || workMode?.getAttribute('aria-selected') === 'true';
          if (!refreshedChatOn || refreshedWorkOn || !refreshedComposer) {
            return { ok:false, error:'chat_mode_switch_failed' };
          }
        }
      }

      const composer = findComposer();
      if (!composer) return { ok:false, error:'chat_composer_not_found' };

      const blockReason = (() => {
        let node = composer;
        while (node) {
          const fiberKey = Object.keys(node).find(key => key.startsWith('__reactFiber$'));
          if (fiberKey) {
            let fiber = node[fiberKey];
            let depth = 0;
            while (fiber && depth < 35) {
              const props = fiber.memoizedProps;
              const reason = props?.disableReason ?? props?.disabledReason;
              if (typeof reason === 'string' && reason) return reason;
              fiber = fiber.return;
              depth += 1;
            }
          }
          node = node.parentElement;
        }
        return null;
      })();
      if (blockReason === 'rate_limit_hard_block') return { ok:false, error:blockReason };

      composer.focus();
      if (composer.isContentEditable) {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(composer);
        selection.removeAllRanges();
        selection.addRange(range);
        try { document.execCommand('delete', false); } catch {}
        if ((composer.innerText || '').trim()) composer.textContent = '';
      } else if ('value' in composer) {
        const proto = Object.getPrototypeOf(composer);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) descriptor.set.call(composer, '');
        else composer.value = '';
        composer.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'deleteContentBackward',
          data: null,
        }));
      } else {
        return { ok:false, error:'chat_composer_not_editable' };
      }
      return { ok:true, baseline };
    })()`, true);

    if (!prepared?.ok) return { ok: false, pane, error: prepared?.error || 'message_prepare_failed' };

    await wc.insertText(message);
    await new Promise(resolve => setTimeout(resolve, 120));

    const sent = await wc.executeJavaScript(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const direct = document.querySelector('[data-testid="send-button"]');
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const send = direct || buttons.find((button) => {
        const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
        return (label.includes('send') || label.includes('enviar')) && !button.disabled;
      });
      if (send && !send.disabled) {
        send.click();
        return { ok:true, method:'button' };
      }
      const composer = document.querySelector('#prompt-textarea')
        || document.querySelector('textarea')
        || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
      const form = composer?.closest('form');
      if (form?.requestSubmit) {
        form.requestSubmit();
        return { ok:true, method:'form' };
      }
      return { ok:false, error:'chat_send_control_not_found' };
    })()`, true);

    if (!sent?.ok) {
      const cleanup = await this.#cleanupComposerDraft(wc);
      return {
        ok: false,
        pane,
        error: sent?.error || 'message_send_failed',
        cleanup,
      };
    }

    const baselineUrl = typeof prepared?.baseline?.url === 'string'
      ? prepared.baseline.url
      : (typeof wc.getURL === 'function' ? wc.getURL() : '');
    const baselineUserMessageCount = Number.isFinite(prepared?.baseline?.userMessageCount)
      ? Number(prepared.baseline.userMessageCount)
      : 0;
    const baselineLastUserMessageId = prepared?.baseline?.lastUserMessageId ?? null;
    const baselineLastAssistantMessageId = prepared?.baseline?.lastAssistantMessageId ?? null;

    let verification = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 150));
      verification = await wc.executeJavaScript(`(() => {
        const baselineUrl = ${JSON.stringify(baselineUrl)};
        const baselineUserMessageCount = ${baselineUserMessageCount};
        const baselineLastUserMessageId = ${JSON.stringify(baselineLastUserMessageId)};
        const baselineLastAssistantMessageId = ${JSON.stringify(baselineLastAssistantMessageId)};
        const composer = document.querySelector('#prompt-textarea')
          || document.querySelector('textarea')
          || document.querySelector('[contenteditable="true"]');
        const text = composer ? String(composer.innerText || composer.value || '').trim() : '';
        const url = location.href;
        const userMessages = [...document.querySelectorAll('[data-message-author-role="user"]')];
        const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
        const userMessageCount = userMessages.length;
        const lastUserMessageId = userMessages.at(-1)?.getAttribute('data-message-id') || null;
        const lastAssistantMessageId = assistantMessages.at(-1)?.getAttribute('data-message-id') || null;
        const composerCleared = !composer || text.length === 0;
        const conversationAdvanced = Boolean(
          (lastUserMessageId && lastUserMessageId !== baselineLastUserMessageId)
          || userMessageCount > baselineUserMessageCount
          || (url !== baselineUrl && /\\/c\\/[^/]+/.test(location.pathname))
        );
        return {
          ok: true,
          composerCleared,
          conversationAdvanced,
          sent: composerCleared && conversationAdvanced,
          url,
          userMessageCount,
          lastUserMessageId,
          lastAssistantMessageId,
          baselineLastAssistantMessageId,
        };
      })()`, true).catch(() => null);
      if (verification?.sent) break;
    }

    if (!verification?.sent) {
      const cleanup = await this.#cleanupComposerDraft(wc);
      return {
        ok: false,
        pane,
        error: 'message_send_unconfirmed',
        method: sent.method ?? null,
        verification,
        cleanup,
      };
    }

    await new Promise(resolve => setTimeout(resolve, 500));
    const postSend = await wc.executeJavaScript(`(() => {
      const expected = ${JSON.stringify(message)};
      const composer = document.querySelector('#prompt-textarea')
        || document.querySelector('textarea')
        || document.querySelector('[contenteditable="true"]');
      const text = composer ? String(composer.innerText || composer.value || composer.textContent || '').trim() : '';
      const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
      const normalizedText = normalize(text);
      const normalizedExpected = normalize(expected);
      const expectedProbe = normalizedExpected.slice(0, 180);
      const automationResidual = Boolean(normalizedText) && (
        normalizedText === normalizedExpected
        || (expectedProbe && normalizedText.includes(expectedProbe))
        || /MCF MISSION|parentMissionId|MCF-AGENT-LIFECYCLE|MCF_AGENT_|MCF_MISSION_/i.test(normalizedText)
      );
      return {
        ok: true,
        composerEmpty: normalizedText.length === 0,
        composerTextLength: normalizedText.length,
        automationResidual,
      };
    })()`, true).catch(error => ({
      ok: false,
      composerEmpty: false,
      composerTextLength: null,
      automationResidual: false,
      error: String(error?.message || error),
    }));

    let postSendCleanup = null;
    if (!postSend?.composerEmpty) {
      if (postSend?.automationResidual) {
        postSendCleanup = await this.#cleanupComposerDraft(wc);
        if (!postSendCleanup?.cleaned) {
          return {
            ok: false,
            pane,
            error: 'message_postsend_draft_cleanup_failed',
            method: sent.method ?? null,
            verification,
            postSend,
            cleanup: postSendCleanup,
          };
        }
      } else {
        return {
          ok: false,
          pane,
          error: 'message_postsend_draft_present',
          method: sent.method ?? null,
          verification,
          postSend,
          cleanup: {
            cleaned: false,
            preserved: true,
            reason: 'unrecognized_draft_preserved',
          },
        };
      }
    }

    this.onEvent({ level: 'ok', message: 'Bridge enviou mensagem confirmada para ' + pane + '.' });
    return {
      ok: true,
      pane,
      method: sent.method ?? null,
      deliveryConfirmed: true,
      composerCleared: Boolean(verification.composerCleared),
      conversationAdvanced: Boolean(verification.conversationAdvanced),
      userMessageCount: verification.userMessageCount ?? null,
      userMessageId: verification.lastUserMessageId ?? null,
      baselineAssistantMessageId: verification.baselineLastAssistantMessageId ?? null,
      postSendStable: Boolean(postSend?.composerEmpty || postSendCleanup?.cleaned),
      postSendCleanup,
      url: verification.url ?? (typeof wc.getURL === 'function' ? wc.getURL() : null),
      title: typeof wc.getTitle === 'function' ? wc.getTitle() : null,
    };
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

      if (req.method === 'GET' && requestUrl.pathname === '/v1/agents') {
        if (typeof this.getAgentIdentities !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_identity_runtime_unavailable' });
        }
        const agents = await this.getAgentIdentities();
        return json(res, 200, { ok: true, agents });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/agents/bootstrap') {
        if (typeof this.bootstrapAgentIdentities !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_identity_runtime_unavailable' });
        }
        const body = await readJson(req);
        const result = await this.bootstrapAgentIdentities(body ?? {});
        return json(res, result?.ok ? 200 : 422, result ?? { ok: false, error: 'agent_bootstrap_failed' });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/mission-envelope') {
        if (typeof this.dispatchAgentMission !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_identity_runtime_unavailable' });
        }
        const body = await readJson(req);
        const result = await this.dispatchAgentMission(body ?? {});
        const status = result?.ok
          ? 200
          : result?.error === 'agent_runtime_initializing'
            ? 503
            : 422;
        return json(res, status, result ?? { ok: false, error: 'mission_dispatch_failed' });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/agent-receipts') {
        if (typeof this.listAgentReceipts !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_identity_runtime_unavailable' });
        }
        const receipts = await this.listAgentReceipts();
        return json(res, 200, { ok: true, receipts });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/missions') {
        if (typeof this.listAgentMissions !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_lifecycle_runtime_unavailable' });
        }
        const missions = await this.listAgentMissions();
        return json(res, 200, { ok: true, missions });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/mission-status') {
        if (typeof this.getAgentMission !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_lifecycle_runtime_unavailable' });
        }
        const envelopeId = String(requestUrl.searchParams.get('envelopeId') || '').trim();
        if (!envelopeId) {
          return json(res, 400, { ok: false, error: 'envelope_id_required' });
        }
        const mission = await this.getAgentMission(envelopeId);
        if (!mission) return json(res, 404, { ok: false, error: 'mission_not_found' });
        return json(res, 200, { ok: true, mission });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/mission-result') {
        if (typeof this.getAgentMission !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_lifecycle_runtime_unavailable' });
        }
        const envelopeId = String(requestUrl.searchParams.get('envelopeId') || '').trim();
        if (!envelopeId) {
          return json(res, 400, { ok: false, error: 'envelope_id_required' });
        }
        const mission = await this.getAgentMission(envelopeId);
        if (!mission) return json(res, 404, { ok: false, error: 'mission_not_found' });
        if (!mission.result) {
          return json(res, 409, {
            ok: false,
            error: 'mission_result_not_captured',
            state: mission.state,
            envelopeId,
          });
        }
        return json(res, 200, {
          ok: true,
          envelopeId,
          state: mission.state,
          result: mission.result,
        });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/parent-mission-status') {
        if (typeof this.getParentAgentMissionStatus !== 'function') {
          return json(res, 503, { ok: false, error: 'agent_lifecycle_runtime_unavailable' });
        }
        const missionId = String(requestUrl.searchParams.get('missionId') || '').trim();
        if (!missionId) {
          return json(res, 400, { ok: false, error: 'mission_id_required' });
        }
        const status = await this.getParentAgentMissionStatus(missionId);
        return json(res, 200, { ok: true, status });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/message') {
        const body = await readJson(req);
        const pane = normalizePaneTarget(body?.pane);
        const message = messageInput(body);
        if (!pane) return json(res, 400, { ok: false, error: 'valid_message_target_required' });
        if (!message) return json(res, 400, { ok: false, error: 'valid_message_required' });
        const result = await this.#sendMessage(pane, message);
        const status = result.ok ? 200 : result.error === 'rate_limit_hard_block' ? 429 : 422;
        return json(res, status, result);
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/messages/broadcast') {
        const body = await readJson(req);
        const message = messageInput(body);
        const rawTargets = Array.isArray(body?.targets) ? body.targets : ['chat', 'workspace'];
        const targets = [...new Set(rawTargets.map(normalizePaneTarget).filter(Boolean))];
        if (!message) return json(res, 400, { ok: false, error: 'valid_message_required' });
        if (!targets.length || targets.length !== rawTargets.length) {
          return json(res, 400, { ok: false, error: 'valid_message_targets_required' });
        }
        const results = await Promise.all(targets.map(target => this.#sendMessage(target, message)));
        const ok = results.every(result => result.ok);
        return json(res, ok ? 200 : 422, { ok, targets, results });
      }

      const body = req.method === 'POST' ? await readJson(req) : null;
      const target = this.#automationTarget(body?.pane ?? requestUrl.searchParams.get('pane'));
      if (!target.ok) {
        return json(res, target.status, {
          ok: false,
          error: target.error,
          ...(target.pane ? { pane: target.pane } : {}),
        });
      }
      const { pane, wc } = target;

      if (req.method === 'GET' && requestUrl.pathname === '/v1/state') {
        return json(res, 200, {
          ok: true,
          state: {
            instanceId: this.instanceId,
            pane,
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
        return json(res, 200, { ok: true, pane, page: text });
      }

      if (req.method === 'GET' && requestUrl.pathname === '/v1/interactive') {
        const page = await wc.executeJavaScript(pageSelectorScript(), true);
        return json(res, 200, { ok: true, pane, page });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/navigate') {
        if (typeof body.url !== 'string' || !/^https?:\/\//i.test(body.url)) {
          return json(res, 400, { ok: false, error: 'http_or_https_url_required' });
        }
        let target;
        try { target = new URL(body.url); } catch { return json(res, 400, { ok: false, error: 'invalid_url' }); }
        if (target.username || target.password) return json(res, 400, { ok: false, error: 'url_credentials_not_allowed' });
        await wc.loadURL(target.href);
        this.onEvent({ level: 'info', message: 'Bridge concluiu navegação.' });
        return json(res, 200, { ok: true, pane, url: wc.getURL() });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/action') {
        const history = wc.navigationHistory;
        if (body.action === 'back' && history.canGoBack()) history.goBack();
        else if (body.action === 'forward' && history.canGoForward()) history.goForward();
        else if (body.action === 'reload') wc.reload();
        else if (body.action === 'stop') wc.stop();
        else return json(res, 400, { ok: false, error: 'invalid_or_unavailable_action' });
        return json(res, 200, { ok: true, pane });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/find-click') {
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
              return json(res, 200, { ok: true, pane, clicked: true, framesChecked });
            }
          } catch {}
        }
        return json(res, 404, { ok: false, pane, error: 'not_found', framesChecked });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/click') {
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
        return json(res, result.ok ? 200 : 404, { ...result, pane });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/type') {
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
        return json(res, result.ok ? 200 : 400, { ...result, pane });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/pointer') {
        if (!Number.isFinite(body.x) || !Number.isFinite(body.y)) {
          return json(res, 400, { ok: false, error: 'x_y_required' });
        }
        const x = Math.max(0, Math.round(body.x));
        const y = Math.max(0, Math.round(body.y));
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
        return json(res, 200, { ok: true, pane });
      }

      if (req.method === 'POST' && requestUrl.pathname === '/v1/upload-file') {
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
          return json(res, 200, { ok: true, pane, filename: path.basename(file) });
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
        if (pane === 'workspace' && typeof this.captureWorkspace === 'function') {
          const result = await this.captureWorkspace();
          return json(res, result?.ok ? 200 : 500, {
            ...(result ?? { ok: false, error: 'capture_failed' }),
            pane,
          });
        }
        mkdirSync(this.captureDir, { recursive: true });
        const image = await wc.capturePage();
        const filename = `${pane}-${Date.now()}.png`;
        const output = path.join(this.captureDir, filename);
        writeFileSync(output, image.toPNG(), { mode: 0o600, flag: 'wx' });
        return json(res, 200, { ok: true, pane, path: output });
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
