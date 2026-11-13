import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_SESSION_MARKER,
  buildAgentSessionDeliveryProbe,
  isAgentSessionDeliveryConfirmed,
} from '../src/main/agent-session-verification.mjs';

test('agent session delivery rejects bootstrap that remains only in composer', () => {
  const evidence = {
    conversationId: null,
    composerContainsBootstrap: true,
    matchingUserTurnCount: 0,
  };
  assert.equal(isAgentSessionDeliveryConfirmed(evidence), false);
});

test('agent session delivery requires conversation identity and matching user turn', () => {
  assert.equal(isAgentSessionDeliveryConfirmed({
    conversationId: 'abc',
    composerContainsBootstrap: false,
    matchingUserTurnCount: 0,
  }), false);

  assert.equal(isAgentSessionDeliveryConfirmed({
    conversationId: null,
    composerContainsBootstrap: false,
    matchingUserTurnCount: 1,
  }), false);

  assert.equal(isAgentSessionDeliveryConfirmed({
    conversationId: 'abc',
    composerContainsBootstrap: false,
    matchingUserTurnCount: 1,
  }), true);
});

test('agent session delivery probe anchors on user-turn DOM, not document body', () => {
  const script = buildAgentSessionDeliveryProbe('session-123');
  assert.ok(script.includes('[data-message-author-role="user"]'));
  assert.ok(script.includes(AGENT_SESSION_MARKER));
  assert.equal(script.includes('document.body'), false);
});

test('modern user-bubble DOM confirms a delivered bootstrap', async () => {
  const { default: vm } = await import('node:vm');
  const sessionId = 'session-e2e-modern';
  const markerText = AGENT_SESSION_MARKER + ' session_id: ' + sessionId;
  const bubble = {
    innerText: markerText, textContent: markerText,
    getAttribute: () => 'user-real-1',
  };
  const document = {
    querySelector: q => q === 'body' ? {} : q.includes('Pergunte ao ChatGPT')
      ? { innerText: '', textContent: '', value: '' } : null,
    querySelectorAll: q => q === '[data-user-message-bubble]' ? [bubble] : [],
  };
  const location = { pathname: '/c/conv-verified-1' };
  const proof = vm.runInNewContext(buildAgentSessionDeliveryProbe(sessionId), { document, location });
  assert.equal(proof.matchingUserTurnCount, 1);
  assert.equal(proof.composerContainsBootstrap, false);
  assert.equal(isAgentSessionDeliveryConfirmed(proof), true);
});

test('accessible Você disse heading provides bounded turn evidence, not body text', async () => {
  const { default: vm } = await import('node:vm');
  const sessionId = 'session-e2e-h4';
  const body = {};
  const heading = { textContent: 'Você disse:', parentElement: null };
  const parent = {
    innerText: AGENT_SESSION_MARKER + ' session_id: ' + sessionId,
    textContent: AGENT_SESSION_MARKER + ' session_id: ' + sessionId,
    parentElement: body,
    querySelectorAll: q => q === 'h4' ? [heading] : [],
    getAttribute: () => null,
  };
  heading.parentElement = parent;
  const document = {
    querySelector: q => q === 'body' ? body : q.includes('Pergunte ao ChatGPT')
      ? { innerText: '', textContent: '', value: '' } : null,
    querySelectorAll: q => q === 'h4' ? [heading] : [],
  };
  const location = { pathname: '/c/conv-verified-2' };
  const proof = vm.runInNewContext(buildAgentSessionDeliveryProbe(sessionId), { document, location });
  assert.equal(proof.matchingUserTurnCount, 1);
  assert.equal(isAgentSessionDeliveryConfirmed(proof), true);
});

test('heading fallback refuses unrelated turn and draft-only bootstrap', async () => {
  const { default: vm } = await import('node:vm');
  const sessionId = 'session-e2e-negative';
  const body = {};
  const heading = { textContent: 'Você disse:', parentElement: null };
  const parent = {
    innerText: 'Outra mensagem não relacionada',
    parentElement: body,
    querySelectorAll: q => q === 'h4' ? [heading] : [],
  };
  heading.parentElement = parent;
  const document = {
    querySelector: q => q === 'body' ? body : q.includes('Pergunte ao ChatGPT')
      ? { innerText: AGENT_SESSION_MARKER + ' ' + sessionId } : null,
    querySelectorAll: q => q === 'h4' ? [heading] : [],
  };
  const location = { pathname: '/c/conv-verified-3' };
  const proof = vm.runInNewContext(buildAgentSessionDeliveryProbe(sessionId), { document, location });
  assert.equal(proof.matchingUserTurnCount, 0);
  assert.equal(proof.composerContainsBootstrap, true);
  assert.equal(isAgentSessionDeliveryConfirmed(proof), false);
});
