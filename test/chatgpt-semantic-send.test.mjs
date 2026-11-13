import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolveChatGPTSendButton, resolveChatGPTComposer, clickChatGPTSendOnce } from '../src/main/chatgpt-semantic-send.mjs';

function button({ label = 'Enviar', testId = null, disabled = false, hidden = false, role = null } = {}) {
  const node = {
    tagName: 'BUTTON',
    title: '', id: '', disabled, clicks: 0,
    getAttribute: k => ({ 'aria-label': label, 'data-testid': testId, 'aria-disabled': null, 'role': role })[k] ?? null,
    getBoundingClientRect: () => ({ width: hidden ? 0 : 40, height: hidden ? 0 : 28 }),
    click() { this.clicks++; },
  };
  return node;
}
function doc(buttons) {
  return {
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    querySelectorAll: q => q === 'button' ? buttons : [],
  };
}
function wc(document) {
  return {
    isDestroyed: () => false,
    executeJavaScript: async script => vm.runInNewContext(script, { document }),
  };
}

test('2026 ChatGPT aria-label Enviar is canonical send control', () => {
  const send = button();
  const result = resolveChatGPTSendButton(doc([send]));
  assert.equal(result.ok, true);
  assert.equal(result.element, send);
});

test('legacy send-button data-testid remains supported', () => {
  const send = button({ label: '', testId: 'send-button' });
  assert.equal(resolveChatGPTSendButton(doc([send])).element, send);
});

test('does not click ambiguous or inactive controls', async () => {
  const a = button();
  const b = button({ label: 'Send' });
  const ambiguous = resolveChatGPTSendButton(doc([a, b]));
  assert.equal(ambiguous.error, 'chat_send_control_ambiguous');
  const result = await clickChatGPTSendOnce(wc(doc([a, b])), { timeoutMs: 100, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(a.clicks + b.clicks, 0);
  assert.equal(resolveChatGPTSendButton(doc([button({ label: 'Parar de responder', testId: 'send-button' })])).ok, false);
  assert.equal(resolveChatGPTSendButton(doc([button({ disabled: true })])).ok, false);
  assert.equal(resolveChatGPTSendButton(doc([button({ hidden: true })])).ok, false);
});

test('generation stop always blocks send, even if a send control is visible', async () => {
  const send = button();
  const stop = button({ label: 'Parar de responder', testId: 'stop-button' });
  const res = await clickChatGPTSendOnce(wc(doc([send, stop])), { timeoutMs: 100, pollMs: 1 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'message_send_blocked_generation_active');
  assert.equal(send.clicks + stop.clicks, 0);
});

test('sends a single click only after control becomes available', async () => {
  const send = button();
  let calls = 0;
  const document = doc([]);
  const transport = wc(document);
  transport.executeJavaScript = async script => {
    calls++;
    if (calls === 2) document.querySelectorAll = q => q === 'button' ? [send] : [];
    return vm.runInNewContext(script, { document });
  };
  const result = await clickChatGPTSendOnce(transport, { timeoutMs: 500, pollMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'semantic-button');
  assert.equal(send.clicks, 1);
  assert.equal(calls, 2);
});

test('an uncertain render exception must never retry an attempted mutation', async () => {
  let runs = 0;
  const result = await clickChatGPTSendOnce({
    isDestroyed: () => false,
    executeJavaScript: async () => { runs++; throw new Error('page went away'); },
  }, { timeoutMs: 300, pollMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chat_send_effect_unknown');
  assert.equal(runs, 1);
});


test('semantic modern composer resolves uniquely, regardless of other editors', () => {
  const editor = {
    tagName: 'DIV', isContentEditable: true,
    getAttribute: k => ({ 'contenteditable': 'true', 'aria-disabled': null })[k] ?? null,
    getBoundingClientRect: () => ({width: 400, height: 90}),
  };
  const other = {
    ...editor,
    getBoundingClientRect: () => ({width: 100, height: 40}),
  };
  const document = {
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    querySelectorAll: q => q.includes('aria-label="Pergunte ao ChatGPT"') ? [editor]
      : q === 'textarea,[contenteditable="true"]' ? [other,editor] : [],
  };
  const result = resolveChatGPTComposer(document);
  assert.equal(result.ok, true);
  assert.equal(result.element, editor);
});

test('multiple explicit ChatGPT composers fail closed', () => {
  const editor = {
    tagName: 'DIV', isContentEditable: true,
    getAttribute: k => k === 'contenteditable' ? 'true' : null,
    getBoundingClientRect: () => ({width: 400, height: 50}),
  };
  const document = {
    defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) },
    querySelectorAll: q => q.includes('aria-label="Pergunte ao ChatGPT"')
      ? [editor, {...editor}] : [],
  };
  const result = resolveChatGPTComposer(document);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chat_composer_ambiguous');
});
