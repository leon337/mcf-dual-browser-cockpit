import { BrowserWindow } from 'electron';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseConversationId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/c\/([^/?#]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
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
    const direct = document.querySelector('[data-testid="send-button"]');
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const send = direct || buttons.find(button => {
      const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
      return (label.includes('send') || label.includes('enviar')) && !button.disabled;
    });
    if (send && !send.disabled) {
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

async function observeAssistant(wc, beforeCount, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let stableText = '';
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (wc.isDestroyed()) throw new Error('chat_surface_destroyed');
    const snapshot = await wc.executeJavaScript(`(() => {
      const assistantNodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const texts = assistantNodes.map(node => String(node.innerText || '').trim()).filter(Boolean);
      const stop = [...document.querySelectorAll('button')].some(button => {
        const label = String(button.getAttribute('aria-label') || button.title || button.innerText || '').toLowerCase();
        return label.includes('stop') || label.includes('parar');
      });
      return {
        count: assistantNodes.length,
        text: texts.at(-1) || '',
        stop,
        url: location.href,
        title: document.title
      };
    })()`, true).catch(() => null);

    if (snapshot && snapshot.count > beforeCount && snapshot.text) {
      if (snapshot.text === stableText) {
        if (!stableSince) stableSince = Date.now();
      } else {
        stableText = snapshot.text;
        stableSince = Date.now();
      }
      if (!snapshot.stop && Date.now() - stableSince >= 1400) return snapshot;
    }
    await sleep(350);
  }
  throw new Error('chatgpt_response_timeout');
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
    lastError: record.lastError ?? null
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

  async open({ id, title = 'Archipelago Chat' } = {}) {
    const key = String(id || '').trim();
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(key)) return {ok:false,error:'valid_conversation_id_required'};

    const existing = this.records.get(key);
    if (existing && existing.window && !existing.window.isDestroyed()) {
      return {ok:true,conversation:publicRecord(existing)};
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
        autoplayPolicy:'no-user-gesture-required'
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
      await win.loadURL(this.chatUrl);
      const ready = await composerReady(win.webContents);
      if (!ready) throw new Error('chat_composer_not_found');
      record.state = 'READY';
      record.chatgptUrl = win.webContents.getURL();
      record.chatgptConversationId = parseConversationId(record.chatgptUrl);
      record.updatedAt = new Date().toISOString();
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
    const beforeCount = await wc.executeJavaScript(`document.querySelectorAll('[data-message-author-role="assistant"]').length`, true).catch(() => 0);
    const prepared = await prepareComposer(wc);
    if (!prepared?.ok) return prepared;

    try {
      await wc.insertText(value);
    } catch (error) {
      return {ok:false,error:'chat_native_insert_failed',detail:error.message};
    }

    await sleep(350);
    const sent = await clickSend(wc);
    if (!sent?.ok) return sent;

    record.state = 'BUSY';
    record.updatedAt = new Date().toISOString();
    try {
      const snapshot = await observeAssistant(wc, beforeCount);
      record.chatgptUrl = snapshot.url || wc.getURL();
      record.chatgptConversationId = parseConversationId(record.chatgptUrl);
      record.state = 'READY';
      record.updatedAt = new Date().toISOString();
      record.lastError = null;
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
      record.lastError = error.message;
      record.updatedAt = new Date().toISOString();
      return {ok:false,error:error.message,conversation:publicRecord(record)};
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
