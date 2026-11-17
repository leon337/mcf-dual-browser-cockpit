import test from 'node:test';
import assert from 'node:assert/strict';
import {
  observeUserTurns, verifyUserTurnDelivery, sampleGenerationDOM, GenerationStallTracker,
} from '../src/main/message-dom.mjs';
import { isGenerationStopControl } from '../src/main/generation-control.mjs';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

const GEMINI = 'https://gemini.google.com/app/190002bbfe6a0dda';
const prompt = 'MCF teste de recuperação do Gemini';
const makeNode = text => ({
  innerText: text,
  getAttribute: () => null,
  closest: () => null,
  querySelector: selector => selector === '.query-content' ? { innerText: text } : null,
});

test('Gemini Angular turn bubbles ignore empty placeholders and recover the full latest prompt', () => {
  const document = {
    querySelectorAll: selector => selector === 'user-query-content'
      ? [makeNode(''), makeNode('Você disse MCF teste...\n\nMCF teste anterior'),
        makeNode(''), makeNode('Você disse MCF teste...\n\n' + prompt), makeNode('')]
      : [],
  };
  const turn = observeUserTurns(document, 'workspace');
  assert.equal(turn.userMessageCount, 2);
  assert.equal(turn.lastUserText, prompt);
  assert.ok(turn.lastUserSignature);
  const before = { url: GEMINI, userMessageCount: 1,
    lastUserSignature: '8:abcdef', lastUserMessageId: null };
  const verified = verifyUserTurnDelivery({
    pane: 'workspace', baseline: before, observation: turn, expectedMessage: prompt,
    composerCleared: true, url: GEMINI,
  });
  assert.equal(verified.sent, true);
  assert.equal(verified.conversationAdvanced, true);
});

test('Gemini delivery rejects reused bubble, unrelated message, changed conversation, or nonempty composer', () => {
  const prior = { url: GEMINI, userMessageCount: 2, lastUserSignature: 'abc' };
  const observation = { userMessageCount: 2, lastUserSignature: 'abc', lastUserText: prompt };
  for (const options of [
    { observation },
    { observation: { ...observation, lastUserSignature: 'def', lastUserText: 'outro pedido' } },
    { observation: { ...observation, userMessageCount: 3 },
      url: 'https://gemini.google.com/app/other' },
    { observation: { ...observation, userMessageCount: 3 }, composerCleared: false },
  ]) {
    const result = verifyUserTurnDelivery({ pane: 'workspace',
      baseline: prior, observation, expectedMessage: prompt,
      composerCleared: true, url: GEMINI, ...options });
    assert.equal(result.sent, false);
  }
});

test('Gemini Parar resposta is correctly detected, never mistaken for send control', () => {
  assert.equal(isGenerationStopControl({ ariaLabel: 'Parar resposta' }), true);
  assert.equal(isGenerationStopControl({ ariaLabel: 'Parar de responder' }), true);
  assert.equal(isGenerationStopControl({ ariaLabel: 'Enviar mensagem' }), false);
});

test('stale generation requires unchanged fingerprint for full threshold', () => {
  let now = 0;
  const tracker = new GenerationStallTracker({ thresholdMs: 2000, clock: () => now });
  const sample = { url: GEMINI, generationActive: true,
    thinkingVisible: true, fingerprint: 'fingerprint-1' };
  assert.equal(tracker.observe('workspace', sample).suspectedStall, false);
  now = 1900;
  assert.equal(tracker.observe('workspace', sample).suspectedStall, false);
  now = 2100;
  assert.equal(tracker.observe('workspace', sample).suspectedStall, true);
  now = 2500;
  assert.equal(tracker.observe('workspace', { ...sample, fingerprint: 'new-output' }).suspectedStall, false);
  now = 4700;
  assert.equal(tracker.observe('workspace', { ...sample, fingerprint: 'new-output' }).suspectedStall, true);
  assert.equal(tracker.observe('workspace', { ...sample, generationActive: false }).suspectedStall, false);
});

test('stop recovery is never automatic; it needs user confirmation and matching fingerprint', async () => {
  let now = 0;
  let active = true;
  let clicks = 0;
  let modal = 0;
  const wc = {
    isDestroyed: () => false,
    getURL: () => GEMINI,
    executeJavaScript: async script => {
      if (script.includes('const fingerprint =')) {
        clicks += 1; active = false;
        return { ok: true, clicked: true, url: GEMINI };
      }
      if (script.includes('Cancelar geração de respostas?')) {
        modal += 1;
        return { modal: true, confirmed: true };
      }
      return { url: GEMINI, generationActive: active,
        fingerprint: 'fixed-sample', thinkingVisible: active };
    },
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: pane => pane === 'workspace' ? wc : null,
    captureDir: '/tmp', instanceId: 'test',
  });
  bridge.generationStalls = new GenerationStallTracker({ thresholdMs: 1000, clock: () => now });
  assert.equal((await bridge.getGenerationStatus('workspace')).suspectedStall, false);
  now = 1200;
  const status = await bridge.getGenerationStatus('workspace');
  assert.equal(status.suspectedStall, true);
  assert.equal((await bridge.recoverGeneration('workspace')).ok, false);
  assert.equal((await bridge.recoverGeneration('workspace',
    { confirm: true, fingerprint: 'wrong' })).ok, false);
  assert.equal(clicks, 0);
  const result = await bridge.recoverGeneration('workspace', {
    confirm: true, fingerprint: status.fingerprint,
  });
  assert.equal(result.ok, true);
  assert.equal(clicks, 1);
  assert.equal(modal, 1);
  assert.equal((await bridge.getGenerationStatus('workspace')).generationActive, false);
});

test('read-only sample protects source content; output contains hash, not model text', () => {
  const originalGetComputedStyle = globalThis.getComputedStyle;
  const originalLocation = globalThis.location;
  try {
    globalThis.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
    globalThis.location = { href: GEMINI };
    const button = {
      getBoundingClientRect: () => ({ width: 50, height: 30 }),
      getAttribute: key => key === 'aria-label' ? 'Parar resposta' : null,
    };
    const response = {
      getBoundingClientRect: () => ({ width: 50, height: 50 }),
      innerText: 'RESPOSTA_PRIVADA_DE_TESTE',
    };
    const sample = sampleGenerationDOM({
      querySelectorAll: query => query === 'button' ? [button]
        : query.includes('model-response') ? [response] : [],
      body: { innerText: 'Raciocínio concluído\nPensando...' },
    });
    assert.equal(sample.generationActive, true);
    assert.equal(sample.thinkingVisible, true);
    assert.equal(JSON.stringify(sample).includes('RESPOSTA_PRIVADA_DE_TESTE'), false);
  } finally {
    globalThis.getComputedStyle = originalGetComputedStyle;
    globalThis.location = originalLocation;
  }
});


test('HTTP recovery endpoints require instance auth and explicit confirmation', async () => {
  const wc = {
    isDestroyed: () => false, getURL: () => GEMINI, getTitle: () => 'Gemini',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    executeJavaScript: async () => ({
      url: GEMINI, generationActive: true,
      fingerprint: 'current', thinkingVisible: true,
    }),
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: pane => pane === 'workspace' ? wc : null,
    captureDir: '/tmp', instanceId: 'qa',
  });
  await bridge.start(0);
  const url = 'http://127.0.0.1:' + bridge.port;
  const headers = { Authorization: 'Bearer ' + bridge.token, 'X-MCF-Instance': 'qa' };
  const get = (route, h = headers) => fetch(url + route, { headers: h });
  const post = (route, data) => fetch(url + route, {
    method: 'POST', headers,
    body: JSON.stringify(data),
  });
  try {
    assert.equal((await get('/v1/generation-status?pane=workspace', {})).status, 401);
    const status = await (await get('/v1/generation-status?pane=workspace')).json();
    assert.equal(status.ok, true);
    assert.equal(status.suspectedStall, false);
    assert.equal((await post('/v1/generation/recover', { pane: 'workspace',
      confirm: false, fingerprint: 'current' })).status, 403);
    assert.equal((await post('/v1/generation/recover', { pane: 'workspace',
      confirm: true, fingerprint: 'incorrect' })).status, 409);
    assert.equal((await get('/v1/message-recovery?pane=workspace')).status, 200);
    assert.equal((await post('/v1/message-recovery/acknowledge',
      { pane: 'workspace' })).status, 409);
    assert.equal((await post('/v1/message-recovery/acknowledge',
      { pane: 'workspace', confirm: true })).status, 200);
    bridge.setPaused(true);
    assert.equal((await post('/v1/generation/recover',
      { pane: 'workspace', confirm: true, fingerprint: 'current' })).status, 423);
    assert.equal((await get('/v1/generation-status?pane=workspace')).status, 200);
  } finally {
    await bridge.stop();
  }
});
