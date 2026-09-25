import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeDiscovery } from '../src/main/runtime-discovery.mjs';

test('runtime discovery exposes pane and Agent Session mechanisms', () => {
  const discovery = buildRuntimeDiscovery({
    instanceId: 'notebook-team2',
    agentProfile: 'debug-engineering',
    paneAgents: [{ agentId: 'Rafael', pane: 'workspace' }],
    canonicalAgents: [{ agentId: 'Rafael' }, { agentId: 'Carmem' }],
    agentSessions: [],
  });

  assert.equal(discovery.schema, 'mcf-dual-browser-runtime-discovery/v1');
  assert.equal(discovery.authority.human, 'LEANDRO');
  assert.equal(discovery.authority.orchestrator, 'MESTRE');
  assert.equal(discovery.mechanisms.agentSessions.routes.open, 'POST /v1/agent-session/open');
  assert.equal(discovery.mechanisms.paneAgents.routes.dispatchMission, 'POST /v1/mission-envelope');
  assert.equal(discovery.mechanisms.paneAgents.startupPolicy.autoBootstrapOnRestoredConversation, false);
  assert.equal(discovery.current.canonicalAgents.length, 2);
});

test('runtime discovery flags legacy OPEN session without /c conversation evidence', () => {
  const discovery = buildRuntimeDiscovery({
    agentSessions: [{
      sessionId: 'legacy',
      surfaceState: 'OPEN',
      bootstrapSent: true,
      bootstrapError: null,
      chatUrl: 'https://chatgpt.com/',
    }],
  });
  const session = discovery.current.agentSessions[0];
  assert.equal(session.deliveryVerified, false);
  assert.equal(session.stateWarning, 'open_without_conversation_evidence');
});

test('runtime discovery verifies an Agent Session only with a conversation URL', () => {
  const discovery = buildRuntimeDiscovery({
    agentSessions: [{
      sessionId: 'verified',
      surfaceState: 'OPEN',
      bootstrapSent: true,
      bootstrapError: null,
      chatUrl: 'https://chatgpt.com/c/abc123',
    }],
  });
  const session = discovery.current.agentSessions[0];
  assert.equal(session.deliveryVerified, true);
  assert.equal(session.conversationId, 'abc123');
  assert.equal(session.stateWarning, null);
});


test('runtime discovery separates restored pane conversation from identity readiness', () => {
  const discovery = buildRuntimeDiscovery({
    paneStates: [{
      pane: 'workspace',
      url: 'https://chatgpt.com/g/g-rafael/c/restored-123',
      title: 'Rafael',
      loading: false,
    }],
    paneAgents: [{
      pane: 'workspace',
      agentId: 'Rafael',
      state: 'ERROR',
      handshakeVerified: false,
      lastError: 'identity_bootstrap_reconciliation_required',
    }],
  });

  assert.equal(discovery.current.panes[0].conversationId, 'restored-123');
  assert.equal(discovery.current.paneAgents[0].state, 'ERROR');
  assert.deepEqual(
    discovery.warnings.find(item => item.warning === 'identity_not_ready_conversation_preserved'),
    {
      source: 'paneIdentity',
      warning: 'identity_not_ready_conversation_preserved',
      pane: 'workspace',
      agentId: 'Rafael',
      state: 'ERROR',
      lastError: 'identity_bootstrap_reconciliation_required',
      conversationId: 'restored-123',
    },
  );
});
