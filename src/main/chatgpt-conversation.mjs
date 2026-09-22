import { BrowserWindow } from 'electron';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseConversationId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(?:c|uc)\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function detectAuthState(wc) {
  return wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const norm = (value) => String(value || '').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
    const controls = [...document.querySelectorAll('a,button,[role="button"]')].filter(visible);
    const labels = controls.map(el => norm(el.getAttribute('aria-label') || el.innerText || el.textContent || ''));
    const guestWords = ['log in','sign in','entrar','fazer login','sign up','criar conta','cadastre-se'];
    const hasGuestControl = labels.some(label => guestWords.some(word => label === word || label.includes(word)));
    const profileSelectors = [
      '[data-testid="profile-button"]',
      '[data-testid*="profile"]',
      '[data-testid*="account"]',
      'button[aria-label*="profile" i]',
      'button[aria-label*="account" i]',
      'button[aria-label*="perfil" i]',
      'button[aria-label*="conta" i]'
    ];
    const hasProfile = profileSelectors.some(selector => [...document.querySelectorAll(selector)].some(visible));
    return {
      state: hasProfile ? 'SIGNED_IN' : hasGuestControl ? 'GUEST' : 'UNKNOWN',
      path: location.pathname,
      hasProfile,
      hasGuestControl
    };
  })()`, true).catch(() => ({state:'UNKNOWN',path:null,hasProfile:false,hasGuestControl:false}));
}

async function composerReady(wc, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) return false;
    const ready = await wc.executeJavaScript(`(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
      };
      const candidates = [
        document.querySelector('#prompt-textarea'),
        document.querySelector('textarea'),
        ...document.querySelectorAll('[contenteditable="true"]')
      ].filter(Boolean);
      return candidates.some(visible);
    })()`, true).catch(() => false);
    if (ready) return true;
    await sleep(400);
  }
  return false;
}

async function prepareComposer(wc) {
  const result = await wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const candidates = [
      document.querySelector('#prompt-textarea'),
      document.querySelector('textarea'),
      ...document.querySelectorAll('[contenteditable="true"]')
    ].filter(Boolean);
    const el = candidates.find(visible);
    if (!el) return {ok:false,error:'chat_composer_not_found'};
    el.focus();
    if (el.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);
      try { document.execCommand('delete', false); } catch {}
      if ((el.innerText || '').trim()) el.textContent = '';
    } else if ('value' in el) {
      const proto = Object.getPrototypeOf(el);
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor?.set) descriptor.set.call(el, '');
      else el.value = '';
      el.dispatchEvent(new InputEvent('input', {bubbles:true,inputType:'deleteContentBackward',data:null}));
    }
    return {ok:true};
  })()`, true).catch(error => ({ok:false,error:error.message}));
  return result;
}

async function clickSend(wc) {
  return wc.executeJavaScript(`(() => {
    const visible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const direct = [
      document.querySelector('[data-testid="send-button"]'),
      document.querySelector('[data-testid="composer-submit-button"]'),
      document.querySelector('button[type="submit"]')
    ].find(el => visible(el) && !el.disabled);
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const semantic = buttons.find(button => {
      const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
      return (label.includes('send') || label.includes('enviar')) && !button.disabled;
    });
    const send = direct || semantic;
    if (send) {
      send.click();
      return {ok:true,method:'button'};
    }
    const composer = document.querySelector('#prompt-textarea') || document.querySelector('textarea') || [...document.querySelectorAll('[contenteditable="true"]')].find(visible);
    const form = composer?.closest('form');
    if (form?.requestSubmit) {
      form.requestSubmit();
      return {ok:true,method:'form'};
    }
    return {ok:false,error:'chat_send_control_not_found'};
  })()`, true).catch(error => ({ok:false,error:error.message}));
}

async function pressEnterToSend(wc) {
  try {
    wc.sendInputEvent({ type:'keyDown', keyCode:'ENTER' });
    wc.sendInputEvent({ type:'keyUp', keyCode:'ENTER' });
    return {ok:true,method:'keyboard'};
  } catch (error) {
    return {ok:false,error:'chat_keyboard_send_failed',detail:error.message};
  }
}

async function waitForSendAck(wc, before, userText, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  const expected = normalizedComparable(userText);
  while (Date.now() < deadline) {
    const snapshot = await conversationSnapshot(wc);
    if (snapshot) last = snapshot;
    if (snapshot) {
      const routeCreated = /^\/(?:c|uc)\//.test(String(snapshot.path || ''));
      const turnAdvanced = snapshot.turnCount > (before?.turnCount || 0);
      const assistantAdvanced = snapshot.assistantCount > (before?.assistantCount || 0);
      const generationStarted = Boolean(snapshot.stop);
      const composer = normalizedComparable(snapshot.composerText);
      const composerCleared = expected && !composer;
      if (routeCreated || turnAdvanced || assistantAdvanced || generationStarted || composerCleared) {
        return {ok:true,snapshot};
      }
    }
    await sleep(250);
  }
  return {ok:false,snapshot:last};
}

async function conversationSnapshot(wc) {
  return wc.executeJavaScript(`(() => {
    const uniq = (items) => [...new Set(items.filter(Boolean))];
    const explicit = uniq([
      ...document.querySelectorAll('[data-message-author-role="assistant"]'),
      ...document.querySelectorAll('[data-turn="assistant"]'),
      ...document.querySelectorAll('[data-author="assistant"]')
    ]);
    const markdown = uniq([
      ...document.querySelectorAll('[data-message-author-role="assistant"] .markdown'),
      ...document.querySelectorAll('[data-message-author-role="assistant"] [class*="markdown"]'),
      ...document.querySelectorAll('article .markdown'),
      ...document.querySelectorAll('[data-testid^="conversation-turn-"] .markdown')
    ]);
    const turns = uniq([
      ...document.querySelectorAll('[data-testid^="conversation-turn-"]'),
      ...document.querySelectorAll('article')
    ]);
    const textOf = (node) => String(node?.innerText || '').trim();
    const explicitTexts = explicit.map(textOf).filter(Boolean);
    const markdownTexts = markdown.map(textOf).filter(Boolean);
    const turnTexts = turns.map(textOf).filter(Boolean);
    const buttons = [...document.querySelectorAll('button')];
    const stop = buttons.some(button => {
      const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
      const testid = String(button.getAttribute('data-testid') || '').toLowerCase();
      return label.includes('stop') || label.includes('parar') || testid.includes('stop');
    });
    const completionButtons = buttons.filter(button => {
      const label = String(button.getAttribute('aria-label') || button.title || '').toLowerCase();
      const testid = String(button.getAttribute('data-testid') || '').toLowerCase();
      return testid === 'copy-turn-action-button' || label.includes('copy response') || label.includes('copiar resposta');
    });
    const completionAction = completionButtons.length > 0;
    const completionTurnTexts = completionButtons.map(button => {
      const turn = button.closest('[data-testid^="conversation-turn-"],article');
      return textOf(turn);
    }).filter(Boolean);
    const bodyText = String(document.body?.innerText || '').slice(-30000);
    const composer = document.querySelector('#prompt-textarea') || document.querySelector('textarea') || [...document.querySelectorAll('[contenteditable="true"]')].find(node => {
      const r = node.getBoundingClientRect();
      const s = getComputedStyle(node);
      return r.width > 20 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden';
    });
    return {
      assistantCount: explicit.length,
      markdownCount: markdown.length,
      turnCount: turns.length,
      assistantText: explicitTexts.at(-1) || '',
      markdownText: markdownTexts.at(-1) || '',
      lastTurnText: turnTexts.at(-1) || '',
      previousTurnText: turnTexts.at(-2) || '',
      composerText: String(composer?.innerText || composer?.value || '').trim(),
      stop,
      completionAction,
      completionTurnText: completionTurnTexts.at(-1) || '',
      bodyText,
      url: location.href,
      path: location.pathname,
      title: document.title
    };
  })()`, true).catch(() => null);
}

function normalizedComparable(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function bodyTailCandidate(snapshot, userText) {
  const body = String(snapshot?.bodyText || '');
  const user = String(userText || '').trim();
  if (!body || !user) return '';
  const index = body.lastIndexOf(user);
  if (index < 0) return '';
  const after = body.slice(index + user.length);
  const noise = [
    /chatgpt can make mistakes/i,
    /o chatgpt pode cometer erros/i,
    /conte[uú]do interativo/i,
    /n[aã]o foi poss[ií]vel carregar os detalhes/i,
    /tentar novamente/i,
    /^copy$/i,
    /^copiar$/i,
    /^share$/i,
    /^compartilhar$/i
  ];
  const lines = after.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.find(line => line !== user && line.length > 0 && line.length < 12000 && !noise.some(rx => rx.test(line))) || '';
}

function responseCandidate(snapshot, before, userText) {
  if (!snapshot) return '';
  const user = normalizedComparable(userText);
  const beforeAssistant = normalizedComparable(before?.assistantText);
  const beforeMarkdown = normalizedComparable(before?.markdownText);
  const candidates = [
    snapshot.assistantCount > (before?.assistantCount || 0) ? snapshot.assistantText : '',
    snapshot.markdownCount > (before?.markdownCount || 0) ? snapshot.markdownText : '',
    snapshot.completionTurnText || '',
    snapshot.turnCount > (before?.turnCount || 0) ? snapshot.lastTurnText : '',
    snapshot.assistantText !== beforeAssistant ? snapshot.assistantText : '',
    snapshot.markdownText !== beforeMarkdown ? snapshot.markdownText : '',
    bodyTailCandidate(snapshot, userText)
  ].map(normalizedComparable).filter(Boolean);

  return candidates.find(text => {
    if (!text) return false;
    if (text === user) return false;
    if (user && text.endsWith(user) && text.length <= user.length + 80) return false;
    return true;
  }) || '';
}

async function observeAssistant(wc, before, userText, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let stableText = '';
  let stableSince = 0;
  let lastSnapshot = null;

  while (Date.now() < deadline) {
    if (wc.isDestroyed()) throw new Error('chat_surface_destroyed');
    const snapshot = await conversationSnapshot(wc);
    if (snapshot) lastSnapshot = snapshot;
    const text = responseCandidate(snapshot, before, userText);

    if (text) {
      if (text === stableText) {
        if (!stableSince) stableSince = Date.now();
      } else {
        stableText = text;
        stableSince = Date.now();
      }
      if (snapshot.completionAction || (!snapshot.stop && Date.now() - stableSince >= 1200)) {
        return { ...snapshot, text };
      }
    }
    await sleep(350);
  }

  const error = new Error('chatgpt_response_timeout');
  error.diagnostics = lastSnapshot;
  throw error;
}

function snapshotDiagnostics(snapshot) {
  if (!snapshot) return null;
  return {
    path: snapshot.path || null,
    assistantCount: Number(snapshot.assistantCount || 0),
    assistantTextLength: String(snapshot.assistantText || '').length,
    markdownCount: Number(snapshot.markdownCount || 0),
    markdownTextLength: String(snapshot.markdownText || '').length,
    turnCount: Number(snapshot.turnCount || 0),
    lastTurnTextLength: String(snapshot.lastTurnText || '').length,
    composerTextLength: String(snapshot.composerText || '').length,
    stop: Boolean(snapshot.stop),
    completionAction: Boolean(snapshot.completionAction),
    completionTurnTextLength: String(snapshot.completionTurnText || '').length,
    bodyTextLength: String(snapshot.bodyText || '').length
  };
}

function publicRecord(record) {
  return {
    id: record.id,
    title: record.title,
    state: record.state,
    chatgptUrl: record.chatgptUrl,
    chatgptConversationId: record.chatgptConversationId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastError: record.lastError ?? null,
    authState: record.authState ?? 'UNKNOWN',
    diagnostics: record.lastDiagnostics ?? null
  };
}

export class ChatGPTConversationBroker {
  constructor({
    partition = 'persist:mcf-chatgpt',
    chatUrl = 'https://chatgpt.com/',
    onEvent = () => {}
  } = {}) {
    this.partition = partition;
    this.chatUrl = chatUrl;
    this.onEvent = onEvent;
    this.records = new Map();
  }

  async open({ id, title = 'Archipelago Chat', url = null } = {}) {
    const key = String(id || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(key)) return {ok:false,error:'valid_conversation_id_required'};

    const existing = this.records.get(key);
    if (existing && existing.window && !existing.window.isDestroyed()) {
      return {ok:true,conversation:publicRecord(existing)};
    }

    let startUrl = this.chatUrl;
    if (url) {
      try {
        const parsed = new URL(String(url));
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'chatgpt.com' || !(parsed.pathname === '/' || parsed.pathname.startsWith('/c/') || parsed.pathname.startsWith('/uc/'))) {
          return {ok:false,error:'invalid_chatgpt_url'};
        }
        startUrl = parsed.href;
      } catch {
        return {ok:false,error:'invalid_chatgpt_url'};
      }
    }

    const now = new Date().toISOString();
    const record = {
      id:key,
      title:String(title || 'Archipelago Chat').slice(0,120),
      state:'CONNECTING',
      chatgptUrl:null,
      chatgptConversationId:null,
      createdAt:now,
      updatedAt:now,
      lastError:null,
      lastDiagnostics:null,
      authState:'UNKNOWN',
      window:null
    };

    const win = new BrowserWindow({
      width:1040,
      height:760,
      show:false,
      autoHideMenuBar:true,
      backgroundColor:'#090d12',
      title:`MCF Archipelago · ${record.title}`,
      webPreferences:{
        partition:this.partition,
        sandbox:true,
        contextIsolation:true,
        nodeIntegration:false,
        webSecurity:true,
        devTools:true,
        autoplayPolicy:'no-user-gesture-required',
        backgroundThrottling:false
      }
    });
    record.window = win;
    this.records.set(key, record);

    win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    win.on('closed', () => {
      record.state = 'CLOSED';
      record.updatedAt = new Date().toISOString();
      record.window = null;
    });

    try {
      await win.loadURL(startUrl);
      const ready = await composerReady(win.webContents);
      if (!ready) throw new Error('chat_composer_not_found');
      const auth = await detectAuthState(win.webContents);
      record.authState = auth.state;
      record.chatgptUrl = win.webContents.getURL();
      record.chatgptConversationId = parseConversationId(record.chatgptUrl);
      record.updatedAt = new Date().toISOString();
      if (auth.state !== 'SIGNED_IN') {
        record.state = 'AUTH_REQUIRED';
        record.lastError = 'chatgpt_auth_required';
        this.onEvent({level:'error',message:'ChatGPT requer login na partição persist:mcf-chatgpt.'});
        return {ok:false,error:'chatgpt_auth_required',conversation:publicRecord(record)};
      }
      record.state = 'READY';
      record.lastError = null;
      this.onEvent({level:'ok',message:`ChatGPT surface READY: ${record.title}`});
      return {ok:true,conversation:publicRecord(record)};
    } catch (error) {
      record.state = 'OFFLINE';
      record.lastError = error.message;
      record.updatedAt = new Date().toISOString();
      this.onEvent({level:'error',message:`ChatGPT surface falhou: ${error.message}`});
      return {ok:false,error:error.message,conversation:publicRecord(record)};
    }
  }

  get(id) {
    const record = this.records.get(String(id || ''));
    if (!record) return null;
    if (record.window?.isDestroyed()) {
      record.window = null;
      record.state = 'CLOSED';
    }
    return publicRecord(record);
  }

  async send({ id, text } = {}) {
    const record = this.records.get(String(id || ''));
    if (!record || !record.window || record.window.isDestroyed()) return {ok:false,error:'conversation_surface_not_found'};
    if (record.state !== 'READY') return {ok:false,error:'conversation_not_ready'};
    const value = String(text || '').trim();
    if (!value || value.length > 12000) return {ok:false,error:'valid_message_required'};

    const wc = record.window.webContents;
    const auth = await detectAuthState(wc);
    record.authState = auth.state;
    if (auth.state !== 'SIGNED_IN') {
      record.state = 'AUTH_REQUIRED';
      record.lastError = 'chatgpt_auth_required';
      record.updatedAt = new Date().toISOString();
      return {ok:false,error:'chatgpt_auth_required',delivery:'NOT_SENT',conversation:publicRecord(record)};
    }
    const beforeSnapshot = await conversationSnapshot(wc) || {assistantCount:0,turnCount:0};
    const prepared = await prepareComposer(wc);
    if (!prepared?.ok) return prepared;

    try {
      await wc.insertText(value);
    } catch (error) {
      return {ok:false,error:'chat_native_insert_failed',detail:error.message};
    }

    await sleep(350);
    let sent = await clickSend(wc);
    if (!sent?.ok) return { ...sent, delivery:'NOT_SENT' };

    let ack = await waitForSendAck(wc, beforeSnapshot, value, 8000);
    if (!ack.ok && normalizedComparable(ack.snapshot?.composerText) === normalizedComparable(value)) {
      const keyboard = await pressEnterToSend(wc);
      if (keyboard.ok) {
        sent = keyboard;
        ack = await waitForSendAck(wc, beforeSnapshot, value, 8000);
      }
    }
    if (!ack.ok) {
      record.state = 'READY';
      record.lastError = 'chat_send_not_confirmed';
      record.updatedAt = new Date().toISOString();
      return {
        ok:false,
        error:'chat_send_not_confirmed',
        delivery:'NOT_SENT',
        diagnostics:ack.snapshot || null,
        conversation:publicRecord(record)
      };
    }

    record.chatgptUrl = ack.snapshot?.url || wc.getURL();
    record.chatgptConversationId = parseConversationId(record.chatgptUrl);
    record.lastDiagnostics = snapshotDiagnostics(ack.snapshot);
    record.state = 'BUSY';
    record.updatedAt = new Date().toISOString();
    try {
      const snapshot = await observeAssistant(wc, beforeSnapshot, value);
      record.chatgptUrl = snapshot.url || wc.getURL();
      record.chatgptConversationId = parseConversationId(record.chatgptUrl);
      record.state = 'READY';
      record.updatedAt = new Date().toISOString();
      record.lastError = null;
      record.lastDiagnostics = snapshotDiagnostics(snapshot);
      return {
        ok:true,
        conversation:publicRecord(record),
        response:{
          role:'assistant',
          text:snapshot.text,
          title:snapshot.title || null
        }
      };
    } catch (error) {
      record.state = 'READY';
      record.chatgptUrl = record.window?.webContents?.getURL?.() || record.chatgptUrl;
      record.chatgptConversationId = parseConversationId(record.chatgptUrl);
      record.lastError = error.message;
      record.lastDiagnostics = snapshotDiagnostics(error.diagnostics);
      record.updatedAt = new Date().toISOString();
      return {ok:false,error:error.message,diagnostics:error.diagnostics || null,conversation:publicRecord(record)};
    }
  }

  close(id) {
    const record = this.records.get(String(id || ''));
    if (!record) return false;
    if (record.window && !record.window.isDestroyed()) record.window.close();
    this.records.delete(record.id);
    return true;
  }

  closeAll() {
    for (const record of this.records.values()) {
      if (record.window && !record.window.isDestroyed()) record.window.close();
    }
    this.records.clear();
  }
}

export { parseConversationId };
