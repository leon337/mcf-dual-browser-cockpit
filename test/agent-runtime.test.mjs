import test from 'node:test';
import assert from 'node:assert/strict';
import { PaneAgentRuntime } from '../src/main/agent-runtime.mjs';
import { agentBindingsForProfile } from '../src/main/agent-identity.mjs';

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
  {
    agentId: 'Patrícia',
    role: 'Debugging e Análise de Falhas',
    contractRef: 'docs/agentes/PATRICIA.md',
    contractDigest: '88b4e68150f1cf732e52cc619388fc17dda37126009cedf533f1a4eefae8c89a',
  },
  {
    agentId: 'Rafael',
    role: 'Engenharia de Software',
    contractRef: 'docs/agentes/RAFAEL.md',
    contractDigest: '9404c3a2e35d8e5c30b6d2ecbc329b879b5eab99cab34408e09386df4f7d5fa9',
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
  const events = [];
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
    onEvent: event => { events.push(structuredClone(event)); },
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
  assert.ok(events.some(event =>
    event.type === 'MISSION_STATE'
    && event.mission?.missionId === 'MISSION-AUDIT-1'
    && event.mission?.state === 'QUEUED'
  ));
  assert.ok(events.some(event =>
    event.type === 'AGENT_RECEIPT'
    && event.receipt?.kind === 'MISSION_ACCEPTED'
    && event.receipt?.agent?.agentId === 'Emily'
  ));
});


test('runtime reconciles a transient fresh-conversation abort before any retry', async () => {
  let freshAttempts = 0;
  let reconciliationChecks = 0;
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
      throw new Error("ERR_ABORTED (-3) loading restored URL");
    },
    reconcileFreshConversation: async pane => {
      reconciliationChecks += 1;
      return {
        ok: true,
        fresh: true,
        composerAvailable: true,
        url: 'https://chatgpt.test/' + pane,
      };
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
  assert.equal(freshAttempts, 1);
  assert.equal(reconciliationChecks, 1);
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
  const events = [];
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
    onEvent: event => { events.push(structuredClone(event)); },
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

  const capturedStateEvent = events.find(event =>
    event.type === 'MISSION_STATE'
    && event.mission?.envelopeId === envelopeId
    && event.mission?.state === 'RESULT_CAPTURED'
  );
  assert.equal(capturedStateEvent?.mission?.result?.bodyAvailable, false);
  assert.equal(capturedStateEvent?.mission?.result?.text, null);

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

  const completedEvent = events.find(event =>
    event.type === 'MISSION_STATE'
    && event.mission?.envelopeId === envelopeId
    && event.mission?.state === 'COMPLETED'
  );
  assert.ok(completedEvent);
  assert.equal(completedEvent.mission.result.bodyAvailable, true);
  assert.equal(completedEvent.mission.result.assistantMessageId, 'msg-final-1');
  assert.equal(completedEvent.mission.result.resultSha256, completed.result.resultSha256);
  assert.match(completedEvent.mission.result.text, /Parecer final completo/);
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
    onEvent: event => { liveEvents.push(structuredClone(event)); },
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



test('conversation change during result observation fails closed and releases the pane queue', async () => {
  let state = null;
  let resultCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-other',
    inspectMissionExecution: async () => ({ ok: true, verified: true, activeExecution: false, generationActive: false, userAnchorFound: true, lateResultObserved: false }),
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true, pane, method: 'button', deliveryConfirmed: true,
      composerCleared: true, conversationAdvanced: true,
      userMessageId: 'user-change', baselineAssistantMessageId: 'assistant-old',
      url: 'https://chatgpt.test/' + pane + '/c/conv-original',
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantStart: async () => ({
      ok: true, accepted: true, assistantMessageId: 'assistant-change',
      markerObserved: false, generationActive: true,
    }),
    waitForAssistantResult: async () => {
      resultCalls += 1;
      return {
        ok: false,
        generationFinished: false,
        generationActive: null,
        terminalSignal: 'conversation_changed',
        expectedConversationId: 'conv-original',
        currentConversationId: 'conv-other',
        assistantMessageId: 'assistant-change',
        linkedUserMessageId: 'user-change',
        url: 'https://chatgpt.test/workspace/c/conv-other',
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-LIVE-AGENT-COMMS-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const first = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-CONVERSATION-CHANGE',
    parentMissionId: 'PARENT-CONVERSATION-CHANGE',
    objective: 'Falhar fechado quando a conversa mudar.',
  });
  await runtime.waitForPendingMissions();

  const firstMission = runtime.getMission(first.envelope.envelopeId);
  assert.equal(resultCalls, 1);
  assert.equal(firstMission.state, 'UNVERIFIED');
  assert.equal(runtime.getParentMissionStatus('PARENT-CONVERSATION-CHANGE').closable, false);
  assert.ok(runtime.listReceipts().some(r =>
    r.kind === 'MISSION_RESULT_UNVERIFIED'
    && r.evidence?.error === 'conversation_changed_during_result_observation'
  ));

  const blocked = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-AFTER-CONVERSATION-CHANGE',
    parentMissionId: 'PARENT-AFTER-CONVERSATION-CHANGE',
    objective: 'Provar que reentrada exige reconciliação antes de novo dispatch.',
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'pane_recovery_required');
  assert.equal(blocked.envelopeId, first.envelope.envelopeId);

  const reconciled = await runtime.reconcileMission({
    envelopeId: first.envelope.envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { conversationChanged: true, activeGeneration: false },
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciliationRequired, false);

  const second = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'SUB-AFTER-CONVERSATION-CHANGE',
    parentMissionId: 'PARENT-AFTER-CONVERSATION-CHANGE',
    objective: 'Provar que reentrada exige reconciliação antes de novo dispatch.',
  });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
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
          error: 'composer_not_found',
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




test('runtime keeps assistant start non-terminal when thinking/tooling activity was observed without a stop control', async () => {
  let state = null;
  let startObservations = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/tooling-start',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-tooling-start',
      baselineAssistantMessageId: 'assistant-before-tooling-start',
      url: 'https://chatgpt.test/' + pane + '/c/tooling-start',
    }),
    waitForAssistantStart: async () => {
      startObservations += 1;
      if (startObservations === 1) {
        return {
          ok: false,
          accepted: false,
          generationActive: false,
          activityObserved: true,
          positiveActivityObserved: true,
          lastActivityAt: Date.now(),
          error: 'assistant_start_timeout',
        };
      }
      return {
        ok: true,
        accepted: true,
        assistantMessageId: 'assistant-tooling-start',
        linkedUserMessageId: 'user-tooling-start',
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
      assistantMessageId: 'assistant-tooling-start',
      linkedUserMessageId: 'user-tooling-start',
      conversationId: 'tooling-start',
      text: 'Resultado final depois de thinking/tooling sem stop control.',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-TOOLING-ACTIVITY-1',
    parentMissionId: 'PARENT-TOOLING-ACTIVITY-1',
    objective: 'Preservar lease durante tooling sem stop control.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(startObservations, 2);
  assert.equal(mission.state, 'COMPLETED');
  const waiting = runtime.listReceipts().find(r =>
    r.kind === 'MISSION_ACCEPTANCE_STILL_WAITING'
    && r.envelope?.envelopeId === dispatched.envelope.envelopeId
  );
  assert.ok(waiting);
  assert.equal(waiting.evidence?.positiveActivityObserved, true);
  assert.equal(waiting.evidence?.generationActive, false);
  assert.equal(Number.isFinite(waiting.evidence?.lastActivityAt), true);
  assert.ok(Date.now() - waiting.evidence.lastActivityAt < 5000);
});


test('runtime reconciles a late assistant result after start timeout without creating a retry', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/late-result',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-late-result',
      baselineAssistantMessageId: 'assistant-before-late-result',
      url: 'https://chatgpt.test/' + pane + '/c/late-result',
    }),
    waitForAssistantStart: async () => ({
      ok: false,
      accepted: false,
      generationActive: false,
      error: 'assistant_start_timeout',
      userMessageId: 'user-late-result',
    }),
    waitForAssistantResult: async (_pane, input, timeoutMs) => {
      assert.equal(input.recovery, true);
      assert.equal(input.startTimeoutRecovery, true);
      assert.equal(input.userMessageId, 'user-late-result');
      assert.equal(timeoutMs, 1234);
      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        finalActionsObserved: true,
        stableForMs: 1600,
        assistantMessageId: 'assistant-late-result',
        linkedUserMessageId: 'user-late-result',
        conversationId: 'late-result',
        text: 'Resultado tardio materializado e reconciliado no envelope original.',
        url: 'https://chatgpt.test/workspace/c/late-result',
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startTimeoutRecoveryMs: 1234,
  });
  await runtime.bootstrap();

  const input = {
    agentId: 'Sofia',
    missionId: 'MISSION-LATE-RESULT-1',
    parentMissionId: 'PARENT-LATE-RESULT-1',
    objective: 'Recuperar resultado tardio sem redispatch.',
  };
  const dispatched = await runtime.dispatchMission(input);
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'COMPLETED');
  assert.equal(mission.attemptNumber, 1);
  assert.equal(mission.retryOfEnvelopeId, null);
  assert.equal(mission.reconciliationRequired, false);
  assert.equal(mission.reconciliationOutcome, 'late_result_validated');
  assert.equal(mission.result.assistantMessageId, 'assistant-late-result');
  assert.equal(mission.result.linkedUserMessageId, 'user-late-result');

  const kinds = runtime.listReceipts()
    .filter(r => r.envelope?.envelopeId === dispatched.envelope.envelopeId)
    .map(r => r.kind);
  assert.ok(kinds.includes('MISSION_RECOVERING'));
  assert.ok(kinds.includes('MISSION_LATE_RESULT_RECOVERED'));
  assert.ok(kinds.includes('MISSION_COMPLETED'));
  assert.equal(kinds.includes('MISSION_ACCEPTANCE_UNVERIFIED'), false);
});

test('runtime blocks retry and new same-pane mission while start-timeout reconciliation is unresolved', async () => {
  let state = null;
  let startCalls = 0;
  let resultCalls = 0;
  let missionSendCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/reconcile-retry',
    inspectMissionExecution: async () => ({ ok: true, verified: true, activeExecution: false, generationActive: false, userAnchorFound: true, lateResultObserved: false }),
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => {
      if (pane === 'workspace') missionSendCalls += 1;
      return {
        ok: true,
        pane,
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-reconcile-' + missionSendCalls,
        baselineAssistantMessageId: 'assistant-before-reconcile-' + missionSendCalls,
        url: 'https://chatgpt.test/' + pane + '/c/reconcile-retry',
      };
    },
    waitForAssistantStart: async () => {
      startCalls += 1;
      if (startCalls === 1) {
        return {
          ok: false,
          accepted: false,
          generationActive: false,
          error: 'assistant_start_timeout',
        };
      }
      return {
        ok: true,
        accepted: true,
        assistantMessageId: 'assistant-retry-success',
        linkedUserMessageId: 'user-reconcile-2',
        markerObserved: true,
        generationActive: true,
      };
    },
    waitForAssistantResult: async () => {
      resultCalls += 1;
      if (resultCalls === 1) {
        return {
          ok: false,
          generationFinished: false,
          generationActive: null,
          terminalSignal: 'result_timeout',
        };
      }
      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        finalActionsObserved: true,
        stableForMs: 1600,
        assistantMessageId: 'assistant-retry-success',
        linkedUserMessageId: 'user-reconcile-2',
        conversationId: 'reconcile-retry',
        text: 'Resultado da tentativa autorizada após reconciliação.',
        url: 'https://chatgpt.test/workspace/c/reconcile-retry',
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startTimeoutRecoveryMs: 5,
  });
  await runtime.bootstrap();
  missionSendCalls = 0;

  const input = {
    agentId: 'Sofia',
    missionId: 'MISSION-RECONCILE-RETRY-1',
    parentMissionId: 'PARENT-RECONCILE-RETRY-1',
    objective: 'Bloquear retry enquanto o efeito anterior for incerto.',
  };
  const first = await runtime.dispatchMission(input);
  await runtime.waitForPendingMissions();

  const firstMission = runtime.getMission(first.envelope.envelopeId);
  assert.equal(firstMission.state, 'UNVERIFIED');
  assert.equal(firstMission.reconciliationRequired, true);
  assert.equal(firstMission.reconciliationReason, 'assistant_start_observation_timeout');

  const checkpoint = runtime.getRecoveryCheckpoint({ pane: 'workspace' });
  assert.equal(checkpoint.ok, true);
  assert.equal(checkpoint.mutationAllowed, false);
  assert.equal(checkpoint.blockers.length, 1);

  const blockedRetry = await runtime.dispatchMission({ ...input, retryFailed: true });
  assert.equal(blockedRetry.ok, false);
  assert.equal(blockedRetry.error, 'mission_reconciliation_required');
  assert.equal(missionSendCalls, 1);

  const blockedNewMission = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-DIFFERENT-WHILE-UNCERTAIN',
    parentMissionId: 'PARENT-RECONCILE-RETRY-1',
    objective: 'Não deve ser despachada antes da reconciliação.',
  });
  assert.equal(blockedNewMission.ok, false);
  assert.equal(blockedNewMission.error, 'pane_recovery_required');
  assert.equal(missionSendCalls, 1);

  const reconciled = await runtime.reconcileMission({
    envelopeId: first.envelope.envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { generationActive: false, lateResultFound: false },
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.reconciliationRequired, false);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, true);

  const retry = await runtime.dispatchMission({ ...input, retryFailed: true });
  assert.equal(retry.ok, true);
  assert.equal(retry.retried, true);
  assert.equal(retry.retryOfEnvelopeId, first.envelope.envelopeId);
  assert.equal(retry.attemptNumber, 2);
  await runtime.waitForPendingMissions();

  const retryMission = runtime.getMission(retry.envelope.envelopeId);
  assert.equal(retryMission.state, 'COMPLETED');
  assert.equal(missionSendCalls, 2);
});

test('reconciliation requirement survives restart and still blocks retry', async () => {
  let state = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/restart-uncertain',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-restart-uncertain',
      baselineAssistantMessageId: 'assistant-before-restart-uncertain',
      url: 'https://chatgpt.test/' + pane + '/c/restart-uncertain',
    }),
    waitForAssistantStart: async () => ({
      ok: false,
      accepted: false,
      generationActive: false,
      error: 'assistant_start_timeout',
    }),
    waitForAssistantResult: async () => ({
      ok: false,
      generationFinished: false,
      generationActive: null,
      terminalSignal: 'result_timeout',
    }),
  };

  const runtimeA = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startTimeoutRecoveryMs: 5,
  });
  await runtimeA.bootstrap();
  const input = {
    agentId: 'Sofia',
    missionId: 'MISSION-RESTART-UNCERTAIN',
    parentMissionId: 'PARENT-RESTART-UNCERTAIN',
    objective: 'Persistir incerteza entre restarts.',
  };
  const first = await runtimeA.dispatchMission(input);
  await runtimeA.waitForPendingMissions();
  assert.equal(runtimeA.getMission(first.envelope.envelopeId).reconciliationRequired, true);

  const runtimeB = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startTimeoutRecoveryMs: 5,
  });
  const restored = runtimeB.getMission(first.envelope.envelopeId);
  assert.equal(restored.state, 'UNVERIFIED');
  assert.equal(restored.reconciliationRequired, true);
  const retry = await runtimeB.dispatchMission({ ...input, retryFailed: true });
  assert.equal(retry.ok, false);
  assert.equal(retry.error, 'mission_reconciliation_required');
});

test('explicit cancellation is a request until no-effect reconciliation confirms terminal cancellation', async () => {
  let state = null;
  let cancelCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  let releaseStart;
  const waitForStart = new Promise(resolve => { releaseStart = resolve; });
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/cancel-explicit',
    inspectMissionExecution: async () => ({ ok: true, verified: true, activeExecution: false, generationActive: false, userAnchorFound: true, lateResultObserved: false }),
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-cancel-explicit',
      baselineAssistantMessageId: 'assistant-before-cancel-explicit',
      url: 'https://chatgpt.test/' + pane + '/c/cancel-explicit',
    }),
    waitForAssistantStart: async () => {
      await waitForStart;
      return {
        ok: false,
        accepted: false,
        interrupted: true,
        error: 'assistant_interrupted',
        linkedUserMessageId: 'user-cancel-explicit',
      };
    },
    cancelAssistantGeneration: async (_pane, input) => {
      cancelCalls += 1;
      assert.match(input.expectedConversationUrl, /cancel-explicit/);
      assert.equal(input.expectedUserMessageId, 'user-cancel-explicit');
      releaseStart();
      return { ok: true, requested: true, generationActive: false };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-CANCEL-EXPLICIT',
    parentMissionId: 'PARENT-CANCEL-EXPLICIT',
    objective: 'Cancelar somente por operação explícita.',
  });

  await new Promise(resolve => setTimeout(resolve, 0));
  const requested = await runtime.requestMissionCancellation({
    envelopeId: dispatched.envelope.envelopeId,
    authority: 'LEANDRO',
    reason: 'Teste explícito de cancelamento.',
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.cancellationRequested, true);
  assert.equal(requested.reconciliationRequired, true);
  assert.equal(cancelCalls, 1);

  await runtime.waitForPendingMissions();
  const interrupted = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(interrupted.state, 'INTERRUPTED');
  assert.equal(interrupted.reconciliationRequired, true);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);

  const reconciled = await runtime.reconcileMission({
    envelopeId: dispatched.envelope.envelopeId,
    outcome: 'cancelled_no_effect_confirmed',
    authority: 'LEANDRO',
    evidence: { generationActive: false, externalEffectObserved: false },
  });
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.state, 'CANCELLED_BY_AUTHORITY');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, true);

  const kinds = runtime.listReceipts()
    .filter(r => r.envelope?.envelopeId === dispatched.envelope.envelopeId)
    .map(r => r.kind);
  assert.ok(kinds.includes('MISSION_CANCEL_REQUESTED'));
  assert.ok(kinds.includes('MISSION_CANCEL_SIGNAL_SENT'));
  assert.ok(kinds.includes('MISSION_CANCELLED_BY_AUTHORITY'));
});


test('cancelling a QUEUED mission defers the Stop signal until its own delivery is identified', async () => {
  let state = null;
  let releaseDelivery;
  let signalDeliveryStarted;
  const deliveryStarted = new Promise(resolve => { signalDeliveryStarted = resolve; });
  const deliveryGate = new Promise(resolve => { releaseDelivery = resolve; });
  let cancelCalls = 0;

  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/queued-cancel',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async (pane, message) => {
      if (!String(message || '').includes('[MCF MISSION ENVELOPE]')) {
        return {
          ok: true,
          pane,
          url: 'https://chatgpt.test/' + pane + '/c/identity-bootstrap',
        };
      }
      signalDeliveryStarted();
      await deliveryGate;
      return {
        ok: true,
        pane,
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-queued-cancel',
        baselineAssistantMessageId: 'assistant-before-queued-cancel',
        url: 'https://chatgpt.test/' + pane + '/c/queued-cancel',
      };
    },
    cancelAssistantGeneration: async (_pane, input) => {
      cancelCalls += 1;
      assert.equal(input.expectedConversationUrl, 'https://chatgpt.test/workspace/c/queued-cancel');
      assert.equal(input.expectedUserMessageId, 'user-queued-cancel');
      return {
        ok: true,
        requested: true,
        generationInactiveObserved: true,
        reconciliationRequired: true,
      };
    },
    waitForAssistantStart: async () => ({
      ok: false,
      accepted: false,
      interrupted: true,
      error: 'assistant_interrupted',
      terminalSignal: 'assistant_interrupted',
      linkedUserMessageId: 'user-queued-cancel',
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-QUEUED-CANCEL-1',
    parentMissionId: 'PARENT-QUEUED-CANCEL-1',
    objective: 'Não parar outra execução enquanto o próprio delivery ainda é desconhecido.',
  });
  await deliveryStarted;

  const requested = await runtime.requestMissionCancellation({
    envelopeId: dispatched.envelope.envelopeId,
    authority: 'LEANDRO',
    reason: 'explicit queued cancellation test',
  });
  assert.equal(requested.ok, true);
  assert.equal(requested.cancellationSignal?.deferred, true);
  assert.equal(cancelCalls, 0);

  releaseDelivery();
  await runtime.waitForPendingMissions();

  assert.equal(cancelCalls, 1);
  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(mission.state, 'INTERRUPTED');
  assert.equal(mission.cancellationRequested, true);
  assert.equal(mission.cancellationSignal?.requested, true);
  const kinds = runtime.listReceipts()
    .filter(r => r.envelope?.envelopeId === dispatched.envelope.envelopeId)
    .map(r => r.kind);
  assert.ok(kinds.includes('MISSION_CANCEL_SIGNAL_DEFERRED'));
  assert.ok(kinds.includes('MISSION_CANCEL_SIGNAL_SENT'));
});


test('historical cancellation request on a COMPLETED mission does not permanently block its pane', async () => {
  let state = null;
  let seq = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/completed-cancel-history',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => {
      seq += 1;
      return {
        ok: true,
        pane,
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-completed-' + seq,
        baselineAssistantMessageId: 'assistant-before-completed-' + seq,
        url: 'https://chatgpt.test/' + pane + '/c/completed-cancel-history',
      };
    },
    waitForAssistantStart: async () => ({
      ok: true,
      accepted: true,
      assistantMessageId: 'assistant-completed-' + seq,
      linkedUserMessageId: 'user-completed-' + seq,
      markerObserved: false,
      generationActive: false,
    }),
    waitForAssistantResult: async () => ({
      ok: true,
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'assistant-completed-' + seq,
      linkedUserMessageId: 'user-completed-' + seq,
      conversationId: 'completed-cancel-history',
      text: 'Resultado terminal ' + seq,
    }),
  };

  const runtime1 = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime1.bootstrap();
  const first = await runtime1.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-COMPLETED-CANCEL-HISTORY-1',
    parentMissionId: 'PARENT-COMPLETED-CANCEL-HISTORY',
    objective: 'Gerar um terminal válido.',
  });
  await runtime1.waitForPendingMissions();
  assert.equal(runtime1.getMission(first.envelope.envelopeId).state, 'COMPLETED');

  state.missions[first.envelope.envelopeId].cancellationRequested = true;
  state.missions[first.envelope.envelopeId].cancellationOutcome = 'too_late_result_completed';
  state.missions[first.envelope.envelopeId].reconciliationRequired = false;

  const runtime2 = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  const second = await runtime2.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-AFTER-COMPLETED-CANCEL-HISTORY',
    parentMissionId: 'PARENT-COMPLETED-CANCEL-HISTORY',
    objective: 'Provar que o pane não fica bloqueado por flag histórica.',
  });
  assert.equal(second.ok, true);
  assert.equal(second.queued, true);
  await runtime2.waitForPendingMissions();
  assert.equal(runtime2.getMission(second.envelope.envelopeId).state, 'COMPLETED');
});


test('runtime bootstraps Patrícia and Rafael with profile-specific immutable pane bindings', async () => {
  const sent = [];
  let persisted = null;
  const bindings = agentBindingsForProfile('debug-engineering');
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('patrícia') ? 'Patrícia' : 'Rafael'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane,
    freshConversation: async () => {},
    sendMessage: async (pane, message) => {
      sent.push({ pane, message });
      return { ok: true, pane, method: 'button', url: 'https://chatgpt.test/' + pane + '/c/new' };
    },
    waitForAssistantMarker: async () => true,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
  });

  const result = await runtime.bootstrap();
  assert.equal(result.ok, true);
  assert.ok(sent.find(x => x.pane === 'chat').message.includes('agent_id: Patrícia'));
  assert.ok(sent.find(x => x.pane === 'workspace').message.includes('agent_id: Rafael'));

  const identities = runtime.getIdentities();
  assert.equal(identities.find(x => x.pane === 'chat').agentId, 'Patrícia');
  assert.equal(identities.find(x => x.pane === 'workspace').agentId, 'Rafael');
  assert.equal(persisted.bindings.chat.agentId, 'Patrícia');
  assert.equal(persisted.bindings.workspace.agentId, 'Rafael');

  const mission = await runtime.dispatchMission({
    agentId: 'Patrícia',
    missionId: 'DEBUG-1',
    objective: 'Reproduzir falha sem implementar correção.',
  });
  assert.equal(mission.ok, true);
  assert.equal(mission.envelope.agent.pane, 'chat');
  assert.equal(mission.envelope.agent.agentId, 'Patrícia');
  await runtime.waitForPendingMissions();
});

test('runtime fails closed when persisted bindings belong to another agent profile', () => {
  const state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    bindings: {
      chat: { agentId: 'Emily' },
      workspace: { agentId: 'Sofia' },
    },
    missions: {},
    receipts: [],
  };

  assert.throws(() => new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker: { listAgents: async () => canonical },
    surface: {},
    agentBindings: agentBindingsForProfile('debug-engineering'),
    loadState: () => state,
    saveState: () => {},
  }), /agent_binding_profile_mismatch/);
});


test('identity bootstrap recovers message_send_unconfirmed when the exact ready marker is observed', async () => {
  const bindings = agentBindingsForProfile('debug-engineering');
  let persisted = null;
  const broker = {
    listAgents: async () => canonical,
    showSession: async () => sessionFor('Rafael'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: () => 'https://chatgpt.test/c/rafael',
    freshConversation: async () => ({ ok: true, url: 'https://chatgpt.test/g/project' }),
    sendMessage: async () => ({ ok: false, error: 'message_send_unconfirmed' }),
    waitForAssistantMarker: async (_pane, marker) => marker.includes('agent_id=Rafael'),
    inspectIdentityBootstrap: async (_pane, input) => ({
      ok: true,
      verified: true,
      userAnchorFound: true,
      markerObserved: true,
      conflictingAttempt: false,
      userMessageId: 'user-rafael',
      assistantMessageId: 'assistant-rafael',
      url: 'https://chatgpt.test/g/project/c/rafael',
      marker: input.marker,
    }),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
  });

  const result = await runtime.bootstrap({ agentId: 'Rafael' });
  assert.equal(result.ok, true);
  assert.equal(persisted.bindings.workspace.state, 'READY');
  assert.equal(persisted.bindings.workspace.handshakeVerified, true);
  const kinds = runtime.listReceipts().map(receipt => receipt.kind);
  assert.ok(kinds.includes('IDENTITY_BOOTSTRAP_DELIVERY_UNCERTAIN'));
  assert.ok(kinds.includes('HANDSHAKE_VERIFIED'));
  assert.equal(kinds.includes('IDENTITY_BOOTSTRAP_DELIVERY_FAILED'), false);
});

test('identity bootstrap reconciles late delivery without creating or sending a duplicate', async () => {
  const bindings = agentBindingsForProfile('debug-engineering');
  let persisted = null;
  let freshCalls = 0;
  let sendCalls = 0;
  let evidenceReady = false;
  const broker = {
    listAgents: async () => canonical,
    showSession: async () => sessionFor('Rafael'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: () => evidenceReady
      ? 'https://chatgpt.test/g/project/c/rafael'
      : 'https://chatgpt.test/g/project',
    freshConversation: async () => {
      freshCalls += 1;
      return { ok: true, url: 'https://chatgpt.test/g/project' };
    },
    sendMessage: async () => {
      sendCalls += 1;
      return { ok: false, error: 'message_send_unconfirmed' };
    },
    waitForAssistantMarker: async () => evidenceReady,
    inspectIdentityBootstrap: async () => ({
      ok: true,
      verified: evidenceReady,
      userAnchorFound: evidenceReady,
      markerObserved: evidenceReady,
      conflictingAttempt: false,
      userMessageId: evidenceReady ? 'user-rafael' : null,
      assistantMessageId: evidenceReady ? 'assistant-rafael' : null,
      url: evidenceReady
        ? 'https://chatgpt.test/g/project/c/rafael'
        : 'https://chatgpt.test/g/project',
      error: evidenceReady ? null : 'identity_bootstrap_user_anchor_not_found',
    }),
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
  });

  const first = await runtime.bootstrap({ agentId: 'Rafael' });
  assert.equal(first.ok, false);
  assert.equal(first.agents[0].error, 'identity_bootstrap_reconciliation_required');
  assert.equal(persisted.bindings.workspace.state, 'RECONCILING');
  assert.equal(persisted.bindings.workspace.reconciliationRequired, true);
  assert.equal(freshCalls, 1);
  assert.equal(sendCalls, 1);

  evidenceReady = true;
  const second = await runtime.bootstrap({ agentId: 'Rafael' });
  assert.equal(second.ok, true);
  assert.equal(second.agents[0].reconciled, true);
  assert.equal(persisted.bindings.workspace.state, 'READY');
  assert.equal(persisted.bindings.workspace.handshakeVerified, true);
  assert.equal(persisted.bindings.workspace.reconciliationRequired, false);
  assert.equal(freshCalls, 1);
  assert.equal(sendCalls, 1);
});

test('identity bootstrap restart reconciles the original uncertain attempt before any resend', async () => {
  const bindings = agentBindingsForProfile('debug-engineering');
  let persisted = null;
  let freshCalls = 0;
  let sendCalls = 0;
  let evidenceReady = false;
  const broker = {
    listAgents: async () => canonical,
    showSession: async () => sessionFor('Rafael'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: () => evidenceReady
      ? 'https://chatgpt.test/g/project/c/restart'
      : 'https://chatgpt.test/g/project',
    freshConversation: async () => {
      freshCalls += 1;
      return { ok: true, url: 'https://chatgpt.test/g/project' };
    },
    sendMessage: async () => {
      sendCalls += 1;
      return { ok: false, error: 'message_send_unconfirmed' };
    },
    waitForAssistantMarker: async () => evidenceReady,
    inspectIdentityBootstrap: async () => ({
      ok: true,
      verified: evidenceReady,
      userAnchorFound: evidenceReady,
      markerObserved: evidenceReady,
      conflictingAttempt: false,
      userMessageId: evidenceReady ? 'user-restart' : null,
      assistantMessageId: evidenceReady ? 'assistant-restart' : null,
      url: evidenceReady
        ? 'https://chatgpt.test/g/project/c/restart'
        : 'https://chatgpt.test/g/project',
      error: evidenceReady ? null : 'identity_bootstrap_user_anchor_not_found',
    }),
  };

  const firstRuntime = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
  });
  const first = await firstRuntime.bootstrap({ agentId: 'Rafael' });
  assert.equal(first.ok, false);
  assert.equal(sendCalls, 1);

  evidenceReady = true;
  const restarted = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => structuredClone(persisted),
    saveState: state => { persisted = structuredClone(state); },
  });
  const recovered = await restarted.bootstrap({ agentId: 'Rafael', force: true });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.agents[0].reconciled, true);
  assert.equal(sendCalls, 1);
  assert.equal(freshCalls, 1);
  assert.equal(persisted.bindings.workspace.state, 'READY');
  assert.equal(persisted.bindings.workspace.handshakeVerified, true);
});

test('identity bootstrap stays fail-closed when uncertain delivery cannot be correlated', async () => {
  const bindings = agentBindingsForProfile('debug-engineering');
  let persisted = null;
  let freshCalls = 0;
  let sendCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async () => sessionFor('Rafael'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: () => 'https://chatgpt.test/g/project',
    freshConversation: async () => {
      freshCalls += 1;
      return { ok: true, url: 'https://chatgpt.test/g/project' };
    },
    sendMessage: async () => {
      sendCalls += 1;
      return { ok: false, error: 'message_send_unconfirmed' };
    },
    waitForAssistantMarker: async () => false,
    inspectIdentityBootstrap: async () => ({
      ok: true,
      verified: false,
      userAnchorFound: false,
      markerObserved: false,
      conflictingAttempt: false,
      url: 'https://chatgpt.test/g/project',
      error: 'identity_bootstrap_user_anchor_not_found',
    }),
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team2',
    missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: state => { persisted = structuredClone(state); },
  });

  const first = await runtime.bootstrap({ agentId: 'Rafael' });
  const second = await runtime.bootstrap({ agentId: 'Rafael', force: true });
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  assert.equal(second.agents[0].error, 'identity_bootstrap_reconciliation_required');
  assert.equal(sendCalls, 1);
  assert.equal(freshCalls, 1);
  assert.equal(persisted.bindings.workspace.state, 'RECONCILING');
  assert.equal(persisted.bindings.workspace.handshakeVerified, false);
});

test('runtime fails closed on lost conversation anchor and releases same-pane queue', async () => {
  let state = null;
  const observedExpectedUrls = [];
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/conv-live',
    inspectMissionExecution: async () => ({ ok: true, verified: true, activeExecution: false, generationActive: false, userAnchorFound: true, lateResultObserved: false }),
    freshConversation: async () => {},
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      url: 'https://chatgpt.test/' + pane + '/c/conv-live',
      deliveryConfirmed: true,
      conversationAdvanced: true,
      userMessageId: 'user-' + pane,
    }),
    waitForAssistantMarker: async () => true,
    waitForAssistantResult: async (_pane, input) => {
      observedExpectedUrls.push(input.expectedConversationUrl);
      if (input.envelope?.missionId === 'MISSION-ANCHOR-LOST') {
        return {
          ok: false,
          generationFinished: false,
          generationActive: null,
          terminalSignal: 'conversation_anchor_lost',
          assistantMessageId: null,
          linkedUserMessageId: input.userMessageId,
          url: input.expectedConversationUrl,
        };
      }
      return {
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'ui_generation_inactive_with_final_actions',
        finalActionsObserved: true,
        stableForMs: 1600,
        assistantMessageId: 'assistant-after-anchor-loss',
        conversationId: 'conv-live',
        linkedUserMessageId: input.userMessageId,
        url: input.expectedConversationUrl,
        text: input.marker + '\nResultado posterior válido.',
      };
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-LIVE-AGENT-COMMS-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });
  await runtime.bootstrap();

  const first = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-ANCHOR-LOST',
    parentMissionId: 'PARENT-LIVE',
    objective: 'Simular perda do anchor.',
  });
  const blockedSecond = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-AFTER-ANCHOR-LOSS',
    parentMissionId: 'PARENT-LIVE',
    objective: 'Provar que a fila só libera após reconciliação.',
  });
  assert.equal(blockedSecond.ok, false);
  assert.equal(blockedSecond.error, 'pane_mission_active');

  await runtime.waitForPendingMissions();

  const firstAfterLoss = runtime.getMission(first.envelope.envelopeId);
  assert.equal(firstAfterLoss.state, 'UNVERIFIED');
  assert.equal(firstAfterLoss.reconciliationRequired, true);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'chat' }).mutationAllowed, false);

  const reconciled = await runtime.reconcileMission({
    envelopeId: first.envelope.envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { currentConversationReconciled: true, lateResultFound: false },
  });
  assert.equal(reconciled.ok, true);

  const second = await runtime.dispatchMission({
    agentId: 'Emily',
    missionId: 'MISSION-AFTER-ANCHOR-LOSS',
    parentMissionId: 'PARENT-LIVE',
    objective: 'Provar que a fila só libera após reconciliação.',
  });
  assert.equal(second.ok, true);
  await runtime.waitForPendingMissions();

  assert.equal(runtime.getMission(second.envelope.envelopeId).state, 'COMPLETED');
  assert.ok(observedExpectedUrls.every(url => url?.endsWith('/c/conv-live')));
  assert.ok(runtime.listReceipts().some(receipt =>
    receipt.kind === 'MISSION_RESULT_UNVERIFIED'
    && receipt.envelope?.envelopeId === first.envelope.envelopeId
    && receipt.evidence?.error === 'conversation_anchor_lost_during_result_observation'
  ));
});


test('reconciliation requires caller evidence plus live proof and refuses active or late execution', async () => {
  let state = null;
  let observation = {
    ok: true,
    verified: true,
    activeExecution: false,
    generationActive: false,
    userAnchorFound: true,
    lateResultObserved: false,
  };
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/reconcile-live-proof',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-reconcile-live-proof',
      baselineAssistantMessageId: 'assistant-before-reconcile-live-proof',
      url: 'https://chatgpt.test/' + pane + '/c/reconcile-live-proof',
    }),
    waitForAssistantStart: async () => ({
      ok: false,
      accepted: false,
      generationActive: false,
      error: 'assistant_start_timeout',
    }),
    waitForAssistantResult: async () => ({
      ok: false,
      generationFinished: false,
      generationActive: false,
      terminalSignal: 'result_timeout',
    }),
    inspectMissionExecution: async () => structuredClone(observation),
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    startTimeoutRecoveryMs: 5,
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-RECONCILE-LIVE-PROOF',
    parentMissionId: 'PARENT-RECONCILE-LIVE-PROOF',
    objective: 'Exigir prova live antes de liberar a pane.',
  });
  await runtime.waitForPendingMissions();
  const envelopeId = dispatched.envelope.envelopeId;
  assert.equal(runtime.getMission(envelopeId).state, 'UNVERIFIED');
  assert.equal(runtime.getMission(envelopeId).reconciliationRequired, true);

  const missingEvidence = await runtime.reconcileMission({
    envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
  });
  assert.equal(missingEvidence.ok, false);
  assert.equal(missingEvidence.error, 'reconciliation_evidence_required');

  observation = { ...observation, activeExecution: true, generationActive: true };
  const active = await runtime.reconcileMission({
    envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { operatorCheckpoint: 'active-check' },
  });
  assert.equal(active.ok, false);
  assert.equal(active.error, 'mission_execution_still_active');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);

  observation = {
    ...observation,
    activeExecution: false,
    generationActive: false,
    lateResultObserved: true,
    assistantMessageId: 'assistant-late-proof',
    assistantTextLength: 42,
  };
  const late = await runtime.reconcileMission({
    envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { operatorCheckpoint: 'late-check' },
  });
  assert.equal(late.ok, false);
  assert.equal(late.error, 'late_result_recovery_incomplete');

  observation = {
    ...observation,
    lateResultObserved: false,
    assistantMessageId: null,
    assistantTextLength: 0,
    toolActivityObserved: true,
  };
  const externalEffect = await runtime.reconcileMission({
    envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { operatorCheckpoint: 'external-effect-check' },
  });
  assert.equal(externalEffect.ok, false);
  assert.equal(externalEffect.error, 'external_effect_reconciliation_required');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);

  observation = {
    ...observation,
    toolActivityObserved: false,
  };
  const illegalCancel = await runtime.reconcileMission({
    envelopeId,
    outcome: 'cancelled_no_effect_confirmed',
    authority: 'LEANDRO',
    evidence: { operatorCheckpoint: 'cancel-check' },
  });
  assert.equal(illegalCancel.ok, false);
  assert.equal(illegalCancel.error, 'explicit_cancellation_required');

  const safe = await runtime.reconcileMission({
    envelopeId,
    outcome: 'no_active_execution_confirmed',
    authority: 'LEANDRO',
    evidence: { operatorCheckpoint: 'safe-check' },
  });
  assert.equal(safe.ok, true);
  assert.equal(safe.reconciliationRequired, false);
  assert.equal(safe.liveEvidence.activeExecution, false);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, true);
});


test('restart during RECOVERING resumes the original envelope and captures a late result', async () => {
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-restart-recovering',
    missionId: 'MISSION-RESTART-RECOVERING',
    parentMissionId: 'PARENT-RESTART-RECOVERING',
    required: true,
    createdAt: '2026-09-24T16:00:00.000Z',
    agent: {
      agentId: 'Sofia',
      role: 'Arquitetura de Software',
      pane: 'workspace',
      contractRef: 'docs/agentes/SOFIA.md',
      contractDigest: canonical[1].contractDigest,
    },
    session: { sessionId: 'session-sofia', traceId: 'trace-sofia' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Recuperar resultado tardio após restart.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    bindings: {},
    receipts: [],
    missions: {
      [envelope.envelopeId]: {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-restart-recovering',
        agentId: 'Sofia',
        role: 'Arquitetura de Software',
        pane: 'workspace',
        sessionId: 'session-sofia',
        traceId: 'trace-sofia',
        contractRef: 'docs/agentes/SOFIA.md',
        contractDigest: canonical[1].contractDigest,
        envelopeDigest: 'c'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=env-restart-recovering agent_id=Sofia',
        delivery: {
          userMessageId: 'user-restart-recovering',
          baselineAssistantMessageId: 'assistant-before-restart-recovering',
          url: 'https://chatgpt.test/workspace/c/restart-recovering',
        },
        acceptedAssistantStartMessageId: 'assistant-restart-recovering',
        acceptedAssistantMessageId: 'assistant-restart-recovering',
        reconciliationRequired: true,
        reconciliationReason: 'assistant_start_observation_timeout',
        state: 'RECOVERING',
        revision: 5,
        result: null,
      },
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/workspace/c/restart-recovering',
      waitForAssistantResult: async (_pane, { marker }) => ({
        ok: true,
        generationFinished: true,
        generationActive: false,
        terminalSignal: 'recovered_terminal_message',
        finalActionsObserved: true,
        stableForMs: 1800,
        assistantMessageId: 'assistant-restart-recovering',
        linkedUserMessageId: 'user-restart-recovering',
        conversationId: 'restart-recovering',
        url: 'https://chatgpt.test/workspace/c/restart-recovering',
        text: marker + '\nResultado tardio recuperado depois do restart.',
      }),
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  const afterConstructor = runtime.getMission(envelope.envelopeId);
  assert.equal(afterConstructor.state, 'UNVERIFIED');
  assert.equal(afterConstructor.reconciliationRequired, true);
  assert.equal(afterConstructor.recoveryResumeRequired, true);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);

  await runtime.recoverPersistedMissions();

  const recovered = runtime.getMission(envelope.envelopeId);
  assert.equal(recovered.state, 'COMPLETED');
  assert.equal(recovered.reconciliationRequired, false);
  assert.equal(recovered.recoveryResumeRequired, false);
  assert.equal(recovered.result.assistantMessageId, 'assistant-restart-recovering');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, true);
});


test('restart recovery timeout remains fail-closed and keeps same-pane mutations blocked', async () => {
  const envelope = {
    schema: 'mcf-mission-envelope/v1',
    envelopeId: 'env-restart-timeout-blocked',
    missionId: 'MISSION-RESTART-TIMEOUT-BLOCKED',
    parentMissionId: 'PARENT-RESTART-TIMEOUT-BLOCKED',
    required: true,
    createdAt: '2026-09-24T16:00:00.000Z',
    agent: {
      agentId: 'Sofia',
      role: 'Arquitetura de Software',
      pane: 'workspace',
      contractRef: 'docs/agentes/SOFIA.md',
      contractDigest: canonical[1].contractDigest,
    },
    session: { sessionId: 'session-sofia', traceId: 'trace-sofia' },
    authority: { human: 'LEANDRO', orchestrator: 'MESTRE' },
    objective: 'Manter recovery bloqueado após timeout.',
    inputs: [],
    constraints: [],
    expectedOutputs: [],
  };
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    bindings: {},
    receipts: [],
    missions: {
      [envelope.envelopeId]: {
        schema: 'mcf-agent-mission-execution/v1',
        envelopeId: envelope.envelopeId,
        missionId: envelope.missionId,
        parentMissionId: envelope.parentMissionId,
        required: true,
        executionId: 'exec-restart-timeout-blocked',
        agentId: 'Sofia',
        role: 'Arquitetura de Software',
        pane: 'workspace',
        sessionId: 'session-sofia',
        traceId: 'trace-sofia',
        contractRef: 'docs/agentes/SOFIA.md',
        contractDigest: canonical[1].contractDigest,
        envelopeDigest: 'd'.repeat(64),
        envelope,
        acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=env-restart-timeout-blocked agent_id=Sofia',
        delivery: {
          userMessageId: 'user-restart-timeout-blocked',
          baselineAssistantMessageId: 'assistant-before-restart-timeout-blocked',
          url: 'https://chatgpt.test/workspace/c/restart-timeout-blocked',
        },
        acceptedAssistantStartMessageId: 'assistant-restart-timeout-blocked',
        acceptedAssistantMessageId: 'assistant-restart-timeout-blocked',
        reconciliationRequired: true,
        reconciliationReason: 'assistant_start_observation_timeout',
        state: 'RECOVERING',
        revision: 5,
        result: null,
      },
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker: {},
    surface: {
      getUrl: () => 'https://chatgpt.test/workspace/c/restart-timeout-blocked',
      waitForAssistantResult: async () => ({
        ok: false,
        generationFinished: false,
        generationActive: true,
        terminalSignal: 'result_timeout',
      }),
    },
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  await runtime.recoverPersistedMissions();
  const blocked = runtime.getMission(envelope.envelopeId);
  assert.equal(blocked.state, 'UNVERIFIED');
  assert.equal(blocked.reconciliationRequired, true);
  assert.equal(blocked.reconciliationReason, 'result_recovery_timeout');
  assert.equal(blocked.recoveryResumeRequired, false);
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);
});


test('stale thinking activity expires its lease and fails closed without endless start retries', async () => {
  let state = null;
  let startCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/stale-lease',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-stale-lease',
      baselineAssistantMessageId: 'assistant-before-stale-lease',
      url: 'https://chatgpt.test/' + pane + '/c/stale-lease',
    }),
    waitForAssistantStart: async () => {
      startCalls += 1;
      return {
        ok: false,
        accepted: false,
        generationActive: false,
        activityObserved: true,
        positiveActivityObserved: true,
        lastActivityAt: Date.now() - 5000,
        error: 'assistant_start_timeout',
      };
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    activityLeaseMs: 250,
    assistantStartHardTimeoutMs: 1500,
  });
  await runtime.bootstrap();
  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-STALE-LEASE',
    parentMissionId: 'PARENT-STALE-LEASE',
    objective: 'Expirar sinal stale de thinking/tooling.',
  });
  await runtime.waitForPendingMissions();
  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.equal(startCalls, 1);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(mission.reconciliationRequired, true);
  assert.equal(mission.reconciliationReason, 'assistant_activity_lease_expired');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);
});


test('result observation hard deadline becomes UNVERIFIED and recovery-blocked', async () => {
  let state = null;
  let resultCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/result-hard-timeout',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-result-hard-timeout',
      baselineAssistantMessageId: 'assistant-before-result-hard-timeout',
      url: 'https://chatgpt.test/' + pane + '/c/result-hard-timeout',
    }),
    waitForAssistantStart: async () => ({
      ok: true,
      accepted: true,
      assistantMessageId: 'assistant-result-hard-timeout',
      linkedUserMessageId: 'user-result-hard-timeout',
      markerObserved: false,
      generationActive: true,
    }),
    waitForAssistantResult: async () => {
      resultCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 550));
      return {
        ok: false,
        generationFinished: false,
        generationActive: true,
        terminalSignal: 'result_timeout',
      };
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    resultHardTimeoutMs: 1000,
  });
  await runtime.bootstrap();
  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-RESULT-HARD-TIMEOUT',
    parentMissionId: 'PARENT-RESULT-HARD-TIMEOUT',
    objective: 'Não permitir loop infinito de result observation.',
  });
  await runtime.waitForPendingMissions();
  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.ok(resultCalls >= 2);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(mission.reconciliationRequired, true);
  assert.equal(mission.reconciliationReason, 'result_hard_timeout');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);
});


test('assistant start hard deadline stops endlessly fresh activity and requires reconciliation', async () => {
  let state = null;
  let startCalls = 0;
  const broker = {
    listAgents: async () => canonical,
    showSession: async sessionId => sessionFor(sessionId.includes('emily') ? 'Emily' : 'Sofia'),
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/c/start-hard-timeout',
    freshConversation: async () => {},
    waitForAssistantMarker: async () => true,
    sendMessage: async pane => ({
      ok: true,
      pane,
      deliveryConfirmed: true,
      composerCleared: true,
      conversationAdvanced: true,
      userMessageId: 'user-start-hard-timeout',
      baselineAssistantMessageId: 'assistant-before-start-hard-timeout',
      url: 'https://chatgpt.test/' + pane + '/c/start-hard-timeout',
    }),
    waitForAssistantStart: async () => {
      startCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 550));
      return {
        ok: false,
        accepted: false,
        generationActive: false,
        activityObserved: true,
        positiveActivityObserved: true,
        lastActivityAt: Date.now(),
        error: 'assistant_start_timeout',
      };
    },
  };
  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-CHATGPT-UI-LIFECYCLE-RACE-001',
    broker,
    surface,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
    activityLeaseMs: 5000,
    assistantStartHardTimeoutMs: 1000,
  });
  await runtime.bootstrap();

  const dispatched = await runtime.dispatchMission({
    agentId: 'Sofia',
    missionId: 'MISSION-START-HARD-TIMEOUT',
    parentMissionId: 'PARENT-START-HARD-TIMEOUT',
    objective: 'Aplicar hard deadline mesmo com atividade continuamente fresca.',
  });
  await runtime.waitForPendingMissions();

  const mission = runtime.getMission(dispatched.envelope.envelopeId);
  assert.ok(startCalls >= 2);
  assert.equal(mission.state, 'UNVERIFIED');
  assert.equal(mission.reconciliationRequired, true);
  assert.equal(mission.reconciliationReason, 'assistant_start_hard_timeout');
  assert.equal(runtime.getRecoveryCheckpoint({ pane: 'workspace' }).mutationAllowed, false);
});

test('parallel bootstrap starts independent panes concurrently', async () => {
  const bindings = agentBindingsForProfile('audit-architecture');
  const started = [];
  let signalBothStarted;
  const bothStarted = new Promise(resolve => { signalBothStarted = resolve; });
  let releaseFresh;
  const freshGate = new Promise(resolve => { releaseFresh = resolve; });

  const broker = {
    listAgents: async () => canonical,
    createSession: async ({ agentId }) => sessionFor(agentId),
    markOpen: async () => ({ ok: true }),
  };
  const urls = {
    chat: 'https://chatgpt.test/g/emily',
    workspace: 'https://chatgpt.test/g/sofia',
  };
  const surface = {
    getUrl: pane => urls[pane],
    freshConversation: async pane => {
      started.push(pane);
      if (started.length === 2) signalBothStarted();
      await freshGate;
      return { ok: true, url: urls[pane] };
    },
    sendMessage: async pane => ({
      ok: true,
      pane,
      method: 'button',
      url: urls[pane] + '/c/new-' + pane,
      userMessageId: 'user-' + pane,
    }),
    waitForAssistantMarker: async () => true,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => null,
    saveState: () => {},
  });

  const pending = runtime.bootstrap({ force: true, parallel: true });
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('parallel_bootstrap_did_not_start_both_panes')),
      250,
    )),
  ]);

  assert.deepEqual([...started].sort(), ['chat', 'workspace']);
  releaseFresh();

  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.parallel, true);
  assert.equal(result.agents.length, 2);
  assert.equal(runtime.getIdentities().every(agent => agent.state === 'READY'), true);
});

