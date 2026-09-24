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


test('runtime keeps parent mission blocked while agent result is still generating and completes only after captured terminal result', async () => {
  let releaseResult;
  const terminalResult = new Promise(resolve => { releaseResult = resolve; });
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-1',
    freshConversation: async () => {},
    sendMessage: async pane => ({ ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/conv-1' }),
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async () => terminalResult,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'SUB-EMILY-1',
    parentMissionId: 'PARENT-1',
    objective: 'Auditar conclusão.',
  });
  const envelopeId = dispatched.envelope.envelopeId;

  for (let i = 0; i < 20; i += 1) {
    const mission = runtime.getMission(envelopeId);
    if (mission?.state === 'WORKING') break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.equal(runtime.getMission(envelopeId).state, 'WORKING');
  assert.equal(runtime.getParentMissionStatus('PARENT-1').closable, false);
  assert.equal(runtime.listReceipts().some(r => r.kind === 'MISSION_COMPLETED'), false);

  releaseResult({
    ok: true,
    generationFinished: true,
    generationActive: false,
    terminalSignal: 'ui_generation_inactive_with_final_actions',
    finalActionsObserved: true,
    stableForMs: 1800,
    assistantMessageId: 'msg-final-1',
    conversationId: 'conv-1',
    url: 'https://chatgpt.test/chat/c/conv-1',
    text: 'MCF_MISSION_ACCEPTED envelope_id=' + envelopeId + ' agent_id=Emily\nParecer final completo.',
  });

  await runtime.waitForPendingMissions();

  const completed = runtime.getMission(envelopeId);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(completed.result.assistantMessageId, 'msg-final-1');
  assert.match(completed.result.resultSha256, /^[a-f0-9]{64}$/);
  assert.equal(runtime.getParentMissionStatus('PARENT-1').closable, true);

  const kinds = runtime.listReceipts()
    .filter(r => r.envelope?.envelopeId === envelopeId)
    .map(r => r.kind);
  assert.deepEqual(kinds, [
    'MISSION_QUEUED',
    'MISSION_DELIVERED',
    'MISSION_ACCEPTED',
    'MISSION_WORKING',
    'MISSION_RESULT_CAPTURED',
    'MISSION_COMPLETED',
  ]);
});

test('runtime blocks COMPLETED when persisted result fails read-back integrity', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-2',
    freshConversation: async () => {},
    sendMessage: async pane => ({ ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/conv-2' }),
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, { marker }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'transport_end_event',
      finalActionsObserved: true,
      stableForMs: 0,
      assistantMessageId: 'msg-final-2',
      conversationId: 'conv-2',
      text: marker + '\nResultado íntegro.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => {
      const copy = state ? structuredClone(state) : null;
      if (copy?.missions) {
        for (const mission of Object.values(copy.missions)) {
          if (mission?.result) mission.result.text += ' adulterado';
        }
      }
      return copy;
    },
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-SOFIA-TAMPER',
    parentMissionId: 'PARENT-TAMPER',
    objective: 'Revisar arquitetura.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(runtime.getParentMissionStatus('PARENT-TAMPER').closable, false);
  assert.equal(runtime.listReceipts().some(r => r.kind === 'MISSION_COMPLETED' && r.envelope?.envelopeId === dispatched.envelope.envelopeId), false);
  assert.ok(runtime.listReceipts().some(r => r.kind === 'MISSION_RESULT_UNVERIFIED'));
});


test('runtime restart marks active work interrupted and recovers only from verifiable terminal result', async () => {
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-restart-1',
    missionId: 'SUB-RESTART-1',
    parentMissionId: 'PARENT-RESTART',
    required: true,
    createdAt: '2026-09-24T07:10:00.000Z',
    agent: {
      agentId: 'Sofia',
      role: 'Arquitetura de Software',
      pane: 'workspace',
      contractRef: 'docs/agentes/SOFIA.md',
      contractDigest: canonical[1].contractDigest,
    },
    session: { sessionId: 'session-sofia', traceId: 'trace-sofia' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Revisar lifecycle.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    bindings: {},
    receipts: [],
    missions: {
      'env-restart-1': {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-restart-1',
        agentId: 'Sofia',
        role: 'Arquitetura de Software',
        pane: 'workspace',
        sessionId: 'session-sofia',
        traceId: 'trace-sofia',
        contractRef: 'docs/agentes/SOFIA.md',
        contractDigest: canonical[1].contractDigest,
        envelopeDigest: 'b'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=env-restart-1 agent_id=Sofia',
        delivery: {
          userMessageId: 'user-restart-1',
          baselineAssistantMessageId: 'assistant-before-restart',
          url: 'https://chatgpt.test/workspace/c/conv-restart',
        },
        acceptedAssistantStartMessageId: 'msg-restart-final',
        acceptedAssistantMessageId: 'msg-restart-final',
        state: 'WORKING',
        revision: 4,
        result: null,
      },
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/workspace/c/conv-restart',
      waitForAssistantResult: async (_pane, { marker }) => ({
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'recovered_terminal_message',
        finalActionsObserved: true,
        stableForMs: 2000,
        assistantMessageId: 'msg-restart-final',
        linkedUserMessageId: 'user-restart-1',
        conversationId: 'conv-restart',
        url: 'https://chatgpt.test/workspace/c/conv-restart',
        text: marker + '\nResultado recuperado após restart.',
      }),
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  assert.equal(runtime.getMission('env-restart-1').state, 'INTERRUPTED');
  assert.equal(runtime.getParentMissionStatus('PARENT-RESTART').closable, false);

  await runtime.recoverPersistedMissions();

  const recovered = runtime.getMission('env-restart-1');
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.result.assistantMessageId, 'msg-restart-final');
  assert.equal(runtime.getParentMissionStatus('PARENT-RESTART').closable, true);
  assert.ok(runtime.listReceipts().some(r => r.kind === 'MISSION_RECOVERING'));
  assert.ok(runtime.listReceipts().some(r => r.kind === 'MISSION_COMPLETED'));
});


test('runtime executes Emily and Sofia lifecycles concurrently while preserving per-pane isolation', async () => {
  let releaseEmily;
  let releaseSofia;
  const gates = {
    chat: new Promise(resolve => { releaseEmily = resolve; }),
    workspace: new Promise(resolve => { releaseSofia = resolve; }),
  };
  const started = [];
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/parallel',
    freshConversation: async () => {},
    sendMessage: async pane => ({ ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/parallel' }),
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (pane, { marker }) => {
      started.push(pane);
      await gates[pane];
      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        finalActionsObserved: true,
        stableForMs: 1600,
        assistantMessageId: 'msg-' + pane,
        conversationId: 'conv-' + pane,
        url: 'https://chatgpt.test/' + pane + '/c/conv-' + pane,
        text: marker + '\nResultado final ' + pane,
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const [emily, sofia] = await Promise.all([
    runtime.dispatchMission({
      agentId: 'Emily',
      missionId: 'PARALLEL-EMILY',
      parentMissionId: 'PARENT-PARALLEL',
      objective: 'Auditar.',
    }),
    runtime.dispatchMission({
      agentId: 'Sofia',
      missionId: 'PARALLEL-SOFIA',
      parentMissionId: 'PARENT-PARALLEL',
      objective: 'Arquitetar.',
    }),
  ]);

  for (let i = 0; i < 30 && new Set(started).size < 2; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  assert.deepEqual([...new Set(started)].sort(), ['chat', 'workspace']);
  assert.equal(runtime.getMission(emily.envelope.envelopeId).state, 'WORKING');
  assert.equal(runtime.getMission(sofia.envelope.envelopeId).state, 'WORKING');
  assert.equal(runtime.getParentMissionStatus('PARENT-PARALLEL').closable, false);

  releaseEmily();
  releaseSofia();
  await runtime.waitForPendingMissions();

  assert.equal(runtime.getMission(emily.envelope.envelopeId).state, 'COMPLETED');
  assert.equal(runtime.getMission(sofia.envelope.envelopeId).state, 'COMPLETED');
  assert.equal(runtime.getParentMissionStatus('PARENT-PARALLEL').closable, true);
});


test('runtime accepts mission by new assistant message identity without requiring textual marker', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-new',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-new',
      baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-new',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async (_pane, { baselineAssistantMessageId }) => ({
      ok: true,
      accepted: true,
      assistantMessageId: 'assistant-new',
      baselineAssistantMessageId,
      markerObserved: false,
      generationActive: true,
    }),
    waitForAssistantResult: async (_pane, { assistantMessageId }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId,
      conversationId: 'conv-new',
      url: 'https://chatgpt.test/chat/c/conv-new',
      text: 'Resultado final sem marcador textual.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'SUB-EMILY-NO-MARKER',
    parentMissionId: 'PARENT-NO-MARKER',
    objective: 'Produzir resultado.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'COMPLETED');
  assert.equal(mission.acceptedAssistantMessageId, 'assistant-new');
  assert.equal(mission.result.assistantMessageId, 'assistant-new');
  assert.equal(mission.result.acceptanceMarkerObserved, false);
  assert.equal(runtime.getParentMissionStatus('PARENT-NO-MARKER').closable, true);
});

test('runtime rejects terminal result from a different assistant message than the accepted turn', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-mismatch',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-new',
      baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-mismatch',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async () => ({
      ok: true,
      accepted: true,
      assistantMessageId: 'assistant-accepted',
      markerObserved: false,
      generationActive: true,
    }),
    waitForAssistantResult: async () => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'assistant-different',
      conversationId: 'conv-mismatch',
      text: 'Resultado de outro turno.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-SOFIA-MISMATCH',
    parentMissionId: 'PARENT-MISMATCH',
    objective: 'Produzir resultado.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(runtime.getParentMissionStatus('PARENT-MISMATCH').closable, false);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_RESULT_UNVERIFIED'
    && r.envelope?.envelopeId === dispatched.envelope.envelopeId
  ));
});


test('runtime keeps WORKING across observation timeout and completes on a later terminal observation', async () => {
  let state = null;
  let resultCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-long',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true, pane, method: 'button', deliveryConfirmed: true,
      composerCleared: true, conversationAdvanced: true,
      userMessageId: 'user-long', baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-long',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async () => ({
      ok: true, accepted: true, assistantMessageId: 'assistant-long',
      markerObserved: false, generationActive: true,
    }),
    waitForAssistantResult: async (_pane, { assistantMessageId }) => {
      resultCalls += 1;
      if (resultCalls === 1) {
        return {
          ok: false,
          generationFinished: false,
          generationActive: true,
          terminalSignal: 'result_timeout',
          assistantMessageId,
        };
      }
      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        finalActionsObserved: true,
        stableForMs: 1600,
        assistantMessageId,
        conversationId: 'conv-long',
        text: 'Resultado final após raciocínio prolongado.',
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();
  const dispatched = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'SUB-LONG',
    parentMissionId: 'PARENT-LONG',
    objective: 'Trabalho demorado.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(resultCalls, 2);
  assert.equal(mission.state, 'COMPLETED');
  assert.equal(runtime.getParentMissionStatus('PARENT-LONG').closable, true);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_STILL_WORKING'
    && r.envelope?.envelopeId === dispatched.envelope.envelopeId
  ));
});


test('runtime permits placeholder assistant id to migrate to the final id for the same delivered user turn', async () => {
  let state = null;
  const placeholderId = 'request-placeholder-request-conv-placeholder-1';
  const finalId = 'assistant-final-uuid';
  const userMessageId = 'user-delivered-uuid';
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-placeholder',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId,
      baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-placeholder',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async (_pane, input) => ({
      ok: true,
      accepted: true,
      assistantMessageId: placeholderId,
      linkedUserMessageId: input.userMessageId,
      markerObserved: false,
      generationActive: true,
    }),
    waitForAssistantResult: async (_pane, input) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1600,
      assistantMessageId: finalId,
      assistantIdMigratedFrom: input.assistantMessageId,
      linkedUserMessageId: input.userMessageId,
      conversationId: 'conv-placeholder',
      url: 'https://chatgpt.test/chat/c/conv-placeholder',
      text: 'Resultado final do mesmo turno lógico.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'SUB-PLACEHOLDER',
    parentMissionId: 'PARENT-PLACEHOLDER',
    objective: 'Concluir mesmo turno após migração de placeholder.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'COMPLETED');
  assert.equal(mission.acceptedAssistantStartMessageId, placeholderId);
  assert.equal(mission.acceptedAssistantMessageId, finalId);
  assert.equal(mission.result.assistantMessageId, finalId);
  assert.equal(mission.result.acceptedAssistantMessageId, finalId);
  assert.equal(mission.result.linkedUserMessageId, userMessageId);
  assert.equal(mission.result.assistantIdMigratedFrom, placeholderId);
  assert.equal(runtime.getParentMissionStatus('PARENT-PLACEHOLDER').closable, true);
});


test('runtime marks mission INTERRUPTED when the visible turn reports interrupted reasoning', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-interrupted',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-interrupted',
      baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-interrupted',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async () => ({
      ok: true,
      accepted: true,
      assistantMessageId: 'request-placeholder-request-conv-interrupted-0',
      linkedUserMessageId: 'user-interrupted',
      markerObserved: false,
      generationActive: true,
    }),
    waitForAssistantResult: async () => ({
      ok: false,
      interrupted: true,
      generationFinished: false,
      generationActive: false,
      terminalSignal: 'assistant_interrupted',
      linkedUserMessageId: 'user-interrupted',
      interruptionText: 'Raciocínio interrompido',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-INTERRUPTED',
    parentMissionId: 'PARENT-INTERRUPTED',
    objective: 'Detectar interrupção visual.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'INTERRUPTED');
  assert.equal(runtime.getParentMissionStatus('PARENT-INTERRUPTED').closable, false);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_INTERRUPTED'
    && r.envelope?.envelopeId === dispatched.envelope.envelopeId
  ));
  assert.equal(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_COMPLETED'
    && r.envelope?.envelopeId === dispatched.envelope.envelopeId
  ), false);
});


test('restart recovery preserves delivered user anchor and migrates placeholder assistant id safely', async () => {
  const placeholderId = 'request-placeholder-request-recovery-0';
  const finalId = 'assistant-recovery-final';
  const userMessageId = 'user-recovery-delivered';
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-recovery-placeholder',
    missionId: 'SUB-RECOVERY-PLACEHOLDER',
    parentMissionId: 'PARENT-RECOVERY-PLACEHOLDER',
    required: true,
    createdAt: '2026-09-24T08:40:00.000Z',
    agent: {
      agentId: 'Emily',
      role: 'Auditoria Independente',
      pane: 'chat',
      contractRef: 'docs/agentes/EMILY.md',
      contractDigest: canonical[0].contractDigest,
    },
    session: { sessionId: 'session-emily', traceId: 'trace-emily' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Recuperar o mesmo turno após restart.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    bindings: {},
    receipts: [],
    missions: {
      [envelope.envelopeId]: {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-recovery-placeholder',
        agentId: 'Emily',
        role: 'Auditoria Independente',
        pane: 'chat',
        sessionId: 'session-emily',
        traceId: 'trace-emily',
        contractRef: 'docs/agentes/EMILY.md',
        contractDigest: canonical[0].contractDigest,
        envelopeDigest: 'c'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=' + envelope.envelopeId + ' agent_id=Emily',
        state: 'WORKING',
        revision: 4,
        delivery: {
          userMessageId,
          baselineAssistantMessageId: 'assistant-before',
          url: 'https://chatgpt.test/chat/c/conv-recovery',
        },
        acceptedAssistantStartMessageId: placeholderId,
        acceptedAssistantMessageId: placeholderId,
        result: null,
      },
    },
  };

  let observedInput = null;
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/chat/c/conv-recovery',
      waitForAssistantResult: async (_pane, input) => {
        observedInput = input;
        return {
          ok: true,
          generationFinished: true,
          generationActive: false,
          terminalSignal: 'recovered_terminal_message',
          finalActionsObserved: true,
          stableForMs: 2200,
          assistantMessageId: finalId,
          assistantIdMigratedFrom: placeholderId,
          linkedUserMessageId: userMessageId,
          conversationId: 'conv-recovery',
          url: 'https://chatgpt.test/chat/c/conv-recovery',
          text: 'Resultado final recuperado do mesmo turno lógico.',
        };
      },
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  assert.equal(runtime.getMission(envelope.envelopeId).state, 'INTERRUPTED');
  await runtime.recoverPersistedMissions();

  assert.equal(observedInput.userMessageId, userMessageId);
  assert.equal(observedInput.assistantMessageId, placeholderId);

  const recovered = runtime.getMission(envelope.envelopeId);
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.acceptedAssistantStartMessageId, placeholderId);
  assert.equal(recovered.acceptedAssistantMessageId, finalId);
  assert.equal(recovered.result.assistantMessageId, finalId);
  assert.equal(recovered.result.linkedUserMessageId, userMessageId);
  assert.equal(recovered.result.assistantIdMigratedFrom, placeholderId);
  assert.equal(runtime.getParentMissionStatus(envelope.parentMissionId).closable, true);
});


test('runtime recovery is bounded and becomes UNVERIFIED when no terminal result is observed', async () => {
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-recovery-timeout',
    missionId: 'SUB-RECOVERY-TIMEOUT',
    parentMissionId: 'PARENT-RECOVERY-TIMEOUT',
    required: true,
    createdAt: '2026-09-24T08:40:00.000Z',
    agent: {
      agentId: 'Emily',
      role: 'Auditoria Independente',
      pane: 'chat',
      contractRef: 'docs/agentes/EMILY.md',
      contractDigest: canonical[0].contractDigest,
    },
    session: { sessionId: 'session-emily', traceId: 'trace-emily' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Recuperar missão antiga.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };

  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    bindings: {},
    receipts: [],
    missions: {
      [envelope.envelopeId]: {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-recovery-timeout',
        agentId: 'Emily',
        role: 'Auditoria Independente',
        pane: 'chat',
        sessionId: 'session-emily',
        traceId: 'trace-emily',
        contractRef: 'docs/agentes/EMILY.md',
        contractDigest: canonical[0].contractDigest,
        envelopeDigest: 'c'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=env-recovery-timeout agent_id=Emily',
        state: 'WORKING',
        revision: 4,
        delivery: {
          userMessageId: 'user-recovery-timeout',
          baselineAssistantMessageId: 'assistant-old',
        },
        acceptedAssistantMessageId: 'request-placeholder-request-recovery-timeout-0',
        result: null,
      },
    },
  };

  let observedInput = null;
  let observedTimeout = null;
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/chat/c/conv-recovery-timeout',
      waitForAssistantResult: async (_pane, input, timeoutMs) => {
        observedInput = input;
        observedTimeout = timeoutMs;
        return {
          ok: false,
          generationFinished: false,
          generationActive: true,
          terminalSignal: 'result_timeout',
        };
      },
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  assert.equal(runtime.getMission(envelope.envelopeId).state, 'INTERRUPTED');

  await runtime.recoverPersistedMissions();

  const mission = runtime.getMission(envelope.envelopeId);
  assert.equal(observedInput.userMessageId, 'user-recovery-timeout');
  assert.equal(observedTimeout, 30000);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(runtime.getParentMissionStatus('PARENT-RECOVERY-TIMEOUT').closable, false);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_RESULT_UNVERIFIED'
    && r.evidence?.error === 'result_recovery_timeout'
  ));
});


test('dispatchMission is idempotent for the same mission, agent and parent', async () => {
  let state = null;
  let sendCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/dedupe',
    freshConversation: async () => {},
    sendMessage: async pane => {
      sendCalls += 1;
      return {
        ok: true,
        pane,
        method: 'button',
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-dedupe',
        baselineAssistantMessageId: 'assistant-old',
        url: 'https://chatgpt.test/' + pane + '/c/dedupe',
      };
    },
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, { marker }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'transport_end_event',
      assistantMessageId: 'assistant-dedupe-final',
      conversationId: 'dedupe',
      url: 'https://chatgpt.test/chat/c/dedupe',
      text: marker + '\nResultado único.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();
  const sendCallsAfterBootstrap = sendCalls;

  const input = {
    agentId: 'Emily',
    missionId: 'MISSION-DEDUPE-1',
    parentMissionId: 'PARENT-DEDUPE-1',
    objective: 'Executar uma única vez.',
  };

  const first = await runtime.dispatchMission(input);
  const second = await runtime.dispatchMission(input);
  await runtime.waitForPendingMissions();

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.envelope.envelopeId, first.envelope.envelopeId);
  assert.equal(sendCalls - sendCallsAfterBootstrap, 1);

  const missions = runtime.listMissions().filter(m =>
    m.missionId === input.missionId
    && m.parentMissionId === input.parentMissionId
    && m.agentId === input.agentId
  );
  assert.equal(missions.length, 1);

  const queued = runtime.listReceipts().filter(r =>
    r.kind === 'MISSION_QUEUED'
    && r.envelope?.missionId === input.missionId
  );
  assert.equal(queued.length, 1);
});


test('runtime rejects conflicting reuse of the same mission id for the same agent and parent', async () => {
  let state = null;
  let sendCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conflict',
    freshConversation: async () => {},
    sendMessage: async pane => {
      sendCalls += 1;
      return {
        ok: true,
        pane,
        method: 'button',
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-conflict',
        baselineAssistantMessageId: 'assistant-old',
        url: 'https://chatgpt.test/' + pane + '/c/conflict',
      };
    },
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, { marker }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'transport_end_event',
      assistantMessageId: 'assistant-conflict-final',
      conversationId: 'conflict',
      url: 'https://chatgpt.test/chat/c/conflict',
      text: marker + '\nResultado único.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();
  const sendsAfterBootstrap = sendCalls;

  const first = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-CONFLICT-1',
    parentMissionId: 'PARENT-CONFLICT-1',
    objective: 'Objetivo original.',
    inputs: ['A'],
  });
  const conflicting = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-CONFLICT-1',
    parentMissionId: 'PARENT-CONFLICT-1',
    objective: 'Objetivo diferente.',
    inputs: ['B'],
  });

  assert.equal(first.ok, true);
  assert.equal(conflicting.ok, false);
  assert.equal(conflicting.error, 'mission_id_conflict');
  assert.equal(conflicting.envelopeId, first.envelope.envelopeId);

  await runtime.waitForPendingMissions();
  assert.equal(sendCalls - sendsAfterBootstrap, 1);
});


test('runtime deduplicates the same logical mission and never sends it twice', async () => {
  let state = null;
  let missionSends = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/dedupe',
    freshConversation: async () => {},
    sendMessage: async (pane, message) => {
      if (String(message).includes('[MCF MISSION ENVELOPE]')) missionSends += 1;
      return {
        ok: true,
        pane,
        method: 'button',
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-dedupe',
        baselineAssistantMessageId: 'assistant-old',
        url: 'https://chatgpt.test/' + pane + '/c/dedupe',
      };
    },
    waitForAssistantMarker: async () => true,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const input = {
    agentId: 'Emily',
    missionId: 'SUB-DEDUPE',
    parentMissionId: 'PARENT-DEDUPE',
    objective: 'Executar uma vez.',
  };

  const first = await runtime.dispatchMission(input);
  const second = await runtime.dispatchMission(input);

  assert.equal(second.ok, true);
  assert.equal(second.deduplicated, true);
  assert.equal(second.envelope.envelopeId, first.envelope.envelopeId);

  await runtime.waitForPendingMissions();

  const matches = runtime.listMissions().filter(m =>
    m.agentId === 'Emily'
    && m.missionId === 'SUB-DEDUPE'
    && m.parentMissionId === 'PARENT-DEDUPE'
  );
  assert.equal(matches.length, 1);
  assert.equal(missionSends, 1);
});

test('runtime recovery fails closed immediately when an interrupted mission has no delivery anchor', async () => {
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-no-delivery-anchor',
    missionId: 'SUB-NO-DELIVERY-ANCHOR',
    parentMissionId: 'PARENT-NO-DELIVERY-ANCHOR',
    required: true,
    createdAt: '2026-09-24T08:50:00.000Z',
    agent: {
      agentId: 'Emily',
      role: 'Auditoria Independente',
      pane: 'chat',
      contractRef: 'docs/agentes/EMILY.md',
      contractDigest: canonical[0].contractDigest,
    },
    session: { sessionId: 'session-emily', traceId: 'trace-emily' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Não inferir recovery.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };

  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    bindings: {},
    receipts: [],
    missions: {
      [envelope.envelopeId]: {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-no-delivery-anchor',
        agentId: 'Emily',
        role: 'Auditoria Independente',
        pane: 'chat',
        sessionId: 'session-emily',
        traceId: 'trace-emily',
        contractRef: 'docs/agentes/EMILY.md',
        contractDigest: canonical[0].contractDigest,
        envelopeDigest: 'd'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=env-no-delivery-anchor agent_id=Emily',
        state: 'QUEUED',
        revision: 1,
        delivery: null,
        acceptedAssistantMessageId: null,
        result: null,
      },
    },
  };

  let recoveryCalls = 0;
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/chat/c/no-delivery-anchor',
      waitForAssistantResult: async () => {
        recoveryCalls += 1;
        return { terminalSignal: 'result_timeout' };
      },
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  assert.equal(runtime.getMission(envelope.envelopeId).state, 'INTERRUPTED');
  await runtime.recoverPersistedMissions();

  const mission = runtime.getMission(envelope.envelopeId);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(recoveryCalls, 0);
  assert.equal(runtime.getParentMissionStatus(envelope.parentMissionId).closable, false);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_RESULT_UNVERIFIED'
    && r.evidence?.error === 'recovery_delivery_anchor_missing'
  ));
});


test('runtime explicitly retries a failed logical mission without breaking idempotency', async () => {
  let state = null;
  let missionSends = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/retry',
    freshConversation: async () => {},
    sendMessage: async (pane, message) => {
      if (!String(message).includes('[MCF MISSION ENVELOPE]')) {
        return {
          ok: true,
          pane,
          method: 'button',
          deliveryConfirmed: true,
          composerCleared: true,
          conversationAdvanced: true,
          userMessageId: 'bootstrap-user',
          baselineAssistantMessageId: 'bootstrap-assistant',
          url: 'https://chatgpt.test/' + pane + '/c/retry',
        };
      }

      missionSends += 1;
      if (missionSends === 1) {
        return {
          ok: false,
          pane,
          error: 'message_send_unconfirmed',
          cleanup: { ok: true, cleaned: true, remainingLength: 0 },
          verification: {
            ok: true,
            composerCleared: false,
            conversationAdvanced: false,
            sent: false,
          },
        };
      }

      return {
        ok: true,
        pane,
        method: 'button',
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-retry-success',
        baselineAssistantMessageId: 'assistant-before-retry',
        url: 'https://chatgpt.test/' + pane + '/c/retry',
      };
    },
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, { marker }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'transport_end_event',
      assistantMessageId: 'assistant-retry-final',
      conversationId: 'retry',
      url: 'https://chatgpt.test/workspace/c/retry',
      text: marker + '\nRetry concluído.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const input = {
    agentId: 'Sofia',
    missionId: 'MISSION-RETRY-FAILED-1',
    parentMissionId: 'PARENT-RETRY-FAILED-1',
    objective: 'Validar retry explícito.',
  };

  const first = await runtime.dispatchMission(input);
  await runtime.waitForPendingMissions();
  assert.equal(runtime.getMission(first.envelope.envelopeId).state, 'FAILED');
  assert.equal(missionSends, 1);

  const dedupe = await runtime.dispatchMission(input);
  assert.equal(dedupe.ok, true);
  assert.equal(dedupe.deduplicated, true);
  assert.equal(dedupe.envelope.envelopeId, first.envelope.envelopeId);
  assert.equal(missionSends, 1);

  const retry = await runtime.dispatchMission({ ...input, retryFailed: true });
  assert.equal(retry.ok, true);
  assert.equal(retry.retried, true);
  assert.equal(retry.retryOfEnvelopeId, first.envelope.envelopeId);
  assert.notEqual(retry.envelope.envelopeId, first.envelope.envelopeId);

  await runtime.waitForPendingMissions();

  assert.equal(runtime.getMission(retry.envelope.envelopeId).state, 'COMPLETED');
  assert.equal(missionSends, 2);

  const attempts = runtime.listMissions().filter(m =>
    m.agentId === input.agentId
    && m.missionId === input.missionId
    && m.parentMissionId === input.parentMissionId
  );
  assert.equal(attempts.length, 2);
  assert.equal(attempts[1].retryOfEnvelopeId, first.envelope.envelopeId);
  assert.equal(attempts[1].attemptNumber, 2);

  const parent = runtime.getParentMissionStatus(input.parentMissionId);
  assert.equal(parent.required, 1);
  assert.equal(parent.completed, 1);
  assert.equal(parent.attempts, 2);
  assert.equal(parent.active, 0);
  assert.equal(parent.closable, true);
});

test('runtime blocks mission dispatch until startup recovery is explicitly completed', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/startup-gate',
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-startup-gate',
      baselineAssistantMessageId: 'assistant-before-startup-gate',
      url: 'https://chatgpt.test/' + pane + '/c/startup-gate',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, { marker }) => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'transport_end_event',
      assistantMessageId: 'assistant-startup-gate-final',
      conversationId: 'startup-gate',
      text: marker + '\nResultado final.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startupReady: false,
  });

  await runtime.bootstrap();

  const blocked = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-STARTUP-GATE-1',
    parentMissionId: 'PARENT-STARTUP-GATE-1',
    objective: 'Não aceitar antes do recovery.',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'agent_runtime_initializing');
  assert.equal(runtime.listMissions().length, 0);

  runtime.markStartupReady();

  const accepted = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-STARTUP-GATE-1',
    parentMissionId: 'PARENT-STARTUP-GATE-1',
    objective: 'Não aceitar antes do recovery.',
  });
  assert.equal(accepted.ok, true);
  await runtime.waitForPendingMissions();
  assert.equal(runtime.getMission(accepted.envelope.envelopeId).state, 'COMPLETED');
});


test('runtime keeps delayed assistant start non-terminal while generation remains active', async () => {
  let state = null;
  let startObservations = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/delayed-start',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-delayed-start',
      baselineAssistantMessageId: 'assistant-before-delayed-start',
      url: 'https://chatgpt.test/' + pane + '/c/delayed-start',
    }),
    waitForAssistantStart: async () => {
      startObservations += 1;
      if (startObservations === 1) {
        return {
          ok: false,
          accepted: false,
          generationActive: true,
          error: 'assistant_start_timeout',
          userMessageId: 'user-delayed-start',
        };
      }
      return {
        ok: true,
        accepted: true,
        assistantMessageId: 'assistant-delayed-start',
        linkedUserMessageId: 'user-delayed-start',
        markerObserved: false,
        generationActive: true,
      };
    },
    waitForAssistantResult: async () => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'assistant-delayed-start',
      conversationId: 'delayed-start',
      text: 'Resultado final após início atrasado.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-AGENT-LIFECYCLE-002',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-DELAYED-START-1',
    parentMissionId: 'PARENT-DELAYED-START-1',
    objective: 'Aguardar início real do assistant.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(startObservations, 2);
  assert.equal(mission.state, 'COMPLETED');
  assert.equal(runtime.getParentMissionStatus('PARENT-DELAYED-START-1').closable, true);

  const kinds = runtime.listReceipts()
    .filter(r => r.envelope?.envelopeId === dispatched.envelope.envelopeId)
    .map(r => r.kind);
  assert.ok(kinds.includes('MISSION_ACCEPTANCE_STILL_WAITING'));
  assert.ok(kinds.includes('MISSION_ACCEPTED'));
  assert.ok(kinds.includes('MISSION_COMPLETED'));
  assert.equal(kinds.includes('MISSION_ACCEPTANCE_UNVERIFIED'), false);
});
