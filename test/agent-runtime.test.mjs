import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneAgentRuntime } from '../src/main/agent-runtime.mjs';

const canonical = [
  {
    agentId: 'Emily',
    role: 'Auditoria Independente',
    contractRef: 'docs/agentes/EMILY.md',
    contractDigest: '9385ac2330d966133814c899540e9f33daad0f5eb423ec6a0a3e4a0bb48d70f4',
  },
  {
    agentId: 'Sofia',
    role: 'Arquitetura de Software',
    contractRef: 'docs/agentes/SOFIA.md',
    contractDigest: '06ffc53d7466471b1541070990b02acde1a7350a63cb41b1b299f3ef0f28b6f3',
  },
];

function sessionFor(agentId) {
  const c = canonical.find(item => item.agentId === agentId);
  return {
    sessionId: 'session-' + agentId.toLowerCase(),
    traceId: 'trace-' + agentId.toLowerCase(),
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    agentId,
    role: c.role,
    contractRef: c.contractRef,
    contractDigest: c.contractDigest,
    bootstrap: '[MCF AGENT SESSION]\ncontract=' + c.contractRef,
  };
}

test('runtime bootstraps both canonical pane identities and persists READY handshakes', async () => {
  const sent = [];
  const fresh = [];
  let persisted = null;
  const urls = {
    chat: 'https://chatgpt.test/g/emily',
    workspace: 'https://chatgpt.test/g/sofia',
  };

  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => {
      const agentId = sessionId.includes('emily') ? 'Emily' : 'Sofia';
      return sessionFor(agentId);
    },
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => urls[pane],
    freshConversation: async pane => { fresh.push(pane); },
    sendMessage: async (pane, message) => {
      sent.push({ pane, message });
      return { ok: true, pane, method: 'button', url: urls[pane] + '/c/new' };
    },
    waitForAssistantMarker: async (_pane, marker) => marker.startsWith('MCF_AGENT_READY'),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    broker,
    surface,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
    now: () => '2026-09-24T03:10:00.000Z',
  });

  const result = await runtime.bootstrap();
  assert.equal(result.ok, true);
  assert.deepEqual(fresh.sort(), ['chat', 'workspace']);
  assert.equal(sent.length, 2);
  assert.ok(sent.find(x => x.pane === 'chat').message.includes('agent_id: Emily'));
  assert.ok(sent.find(x => x.pane === 'workspace').message.includes('agent_id: Sofia'));

  const agents = runtime.getIdentities();
  assert.equal(agents.find(x => x.agentId === 'Emily').state, 'READY');
  assert.equal(agents.find(x => x.agentId === 'Sofia').state, 'READY');
  assert.equal(persisted.bindings.chat.agentId, 'Emily');
  assert.equal(persisted.bindings.workspace.agentId, 'Sofia');

  const kinds = runtime.listReceipts().map(r => r.kind);
  assert.equal(kinds.filter(k => k === 'IDENTITY_BOOTSTRAP_DELIVERED').length, 2);
  assert.equal(kinds.filter(k => k === 'HANDSHAKE_VERIFIED').length, 2);
});

test('runtime dispatches mission envelope only to the identity-bound pane and records truthful receipts', async () => {
  const sent = [];
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane,
    freshConversation: async () => {},
    sendMessage: async (pane, message) => {
      sent.push({ pane, message });
      return { ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/1' };
    },
    waitForAssistantMarker: async (_pane, marker) => marker.startsWith('MCF_'),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    now: () => '2026-09-24T03:11:00.000Z',
  });
  await runtime.bootstrap();

  sent.length = 0;
  const result = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-AUDIT-1',
    objective: 'Auditar o runtime de identidade.',
    inputs: ['commit:abc'],
    expectedOutputs: ['parecer'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(result.accepted, null);
  assert.equal(result.deliveryPending, true);
  assert.equal(result.acceptancePending, true);
  assert.equal(sent.length, 0);
  assert.equal(result.envelope.agent.agentId, 'Emily');
  assert.equal(result.receipt.status, 'QUEUED');
  assert.equal(result.acceptanceReceipt, null);

  await runtime.waitForPendingMissions();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, 'chat');
  assert.ok(sent[0].message.includes('[MCF MISSION ENVELOPE]'));
  const receipts = runtime.listReceipts();
  assert.ok(receipts.some(r => r.kind === 'MISSION_DELIVERED' && r.agent.agentId === 'Emily'));
  assert.ok(receipts.some(r => r.kind === 'MISSION_ACCEPTED' && r.agent.agentId === 'Emily'));
});


test('runtime retries transient fresh-conversation aborts before failing identity bootstrap', async () => {
  let freshAttempts = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane,
    freshConversation: async () => {
      freshAttempts += 1;
      if (freshAttempts === 1) throw new Error("ERR_ABORTED (-3) loading restored URL");
    },
    sendMessage: async (pane) => ({ ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/new' }),
    waitForAssistantMarker: async () => true,
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    broker,
    surface,
    loadState: () => null,
    saveState: () => {},
  });

  const result = await runtime.bootstrap({ agentId: 'Emily' });
  assert.equal(result.ok, true);
  assert.equal(freshAttempts, 2);
  assert.equal(runtime.getIdentities().find(x => x.agentId === 'Emily').state, 'READY');
});


test('runtime can return mission delivery immediately while acceptance is observed asynchronously', async () => {
  let releaseAcceptance;
  const acceptance = new Promise(resolve => { releaseAcceptance = resolve; });
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane,
    freshConversation: async () => {},
    sendMessage: async (pane) => ({ ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/1' }),
    waitForAssistantMarker: async (_pane, marker) => {
      if (marker.startsWith('MCF_AGENT_READY')) return true;
      return acceptance;
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    broker,
    surface,
    loadState: () => null,
    saveState: () => {},
  });
  await runtime.bootstrap();

  const started = Date.now();
  const result = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-ASYNC-1',
    objective: 'Revisar arquitetura.',
  }, { waitForAcceptance: false });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, true);
  assert.equal(result.accepted, null);
  assert.equal(result.acceptancePending, true);
  assert.ok(elapsed < 150, 'delivery should not wait for agent acceptance');

  releaseAcceptance(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(runtime.listReceipts().some(
    receipt => receipt.kind === 'MISSION_ACCEPTED' && receipt.envelope?.missionId === 'MISSION-ASYNC-1',
  ));
});
