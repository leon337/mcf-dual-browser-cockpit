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
