import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIdentityBootstrapProbe,
  isIdentityBootstrapEvidenceVerified,
} from '../src/main/identity-bootstrap-verification.mjs';

function fakeNode(text, attrs = {}) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    querySelector() {
      return null;
    },
    contains(other) {
      return other === this;
    },
  };
}

test('identity probe falls back to conversation turns and accepts /project -> /c transition', () => {
  const sessionId = 'session-emily';
  const marker = 'MCF_AGENT_READY agent_id=Emily session_id=' + sessionId;
  const bootstrap = fakeNode([
    '[MCF PANE AGENT IDENTITY]',
    'agent_id: Emily',
    'session_id: ' + sessionId,
    'contract_sha256: ' + 'a'.repeat(64),
  ].join('\n'));
  const reply = fakeNode(marker);

  const document = {
    querySelector(selector) {
      if (selector === '#prompt-textarea') return fakeNode('');
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role]') return [];
      if (selector.includes('conversation-turn-')) return [bootstrap, reply];
      return [];
    },
  };
  const location = {
    href: 'https://chatgpt.com/g/g-emily/c/12345678-1234-1234-1234-123456789abc',
  };

  const script = buildIdentityBootstrapProbe({
    agentId: 'Emily',
    sessionId,
    contractDigest: 'a'.repeat(64),
    marker,
    expectedProjectRoot: 'https://chatgpt.com/g/g-emily/project',
  });

  const evidence = Function('document', 'location', 'URL', '"use strict"; return ' + script)(
    document,
    location,
    URL,
  );

  assert.equal(evidence.verified, true);
  assert.equal(evidence.source, 'conversation-turn');
  assert.equal(evidence.userAnchorFound, true);
  assert.equal(evidence.markerObserved, true);
  assert.equal(evidence.projectRootOk, true);
  assert.equal(evidence.composerContainsBootstrap, false);
  assert.equal(isIdentityBootstrapEvidenceVerified(evidence), true);
});

test('identity probe never uses document.body as delivery evidence', () => {
  const script = buildIdentityBootstrapProbe({
    agentId: 'Emily',
    sessionId: 'session-emily',
    contractDigest: 'a'.repeat(64),
    marker: 'MCF_AGENT_READY agent_id=Emily session_id=session-emily',
  });

  assert.equal(script.includes('document.body'), false);
  assert.equal(script.includes('conversation-turn-'), true);
});

test('identity verification remains fail-closed when bootstrap is still in composer', () => {
  assert.equal(isIdentityBootstrapEvidenceVerified({
    ok: true,
    verified: true,
    userAnchorFound: true,
    markerObserved: true,
    conflictingAttempt: false,
    composerContainsBootstrap: true,
    conversationUrlOk: true,
    projectRootOk: true,
  }), false);
});
