import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PaneAgentRuntime } from '../src/main/agent-runtime.mjs';
import {
  agentBindingsForProfile,
  agentMissionIdForProfile,
} from '../src/main/agent-identity.mjs';
import { instanceConfig } from '../src/main/instance.mjs';

const bindings = agentBindingsForProfile('backend-quality');
const missionId = agentMissionIdForProfile('backend-quality');

const canonical = [
  {
    agentId: 'Renato',
    role: 'Qualidade e Testes',
    contractRef: 'docs/agentes/RENATO.md',
    contractDigest: '1'.repeat(64),
  },
  {
    agentId: 'Eduardo',
    role: 'Engenharia Backend',
    contractRef: 'docs/agentes/EDUARDO.md',
    contractDigest: '2'.repeat(64),
  },
];

function sessionFor(agentId) {
  const canonicalAgent = canonical.find(item => item.agentId === agentId);
  return {
    sessionId: 'session-' + agentId.toLowerCase(),
    traceId: 'trace-' + agentId.toLowerCase(),
    missionId,
    agentId,
    role: canonicalAgent.role,
    contractRef: canonicalAgent.contractRef,
    contractDigest: canonicalAgent.contractDigest,
    bootstrap: '[MCF AGENT SESSION]\ncontract=' + canonicalAgent.contractRef,
  };
}

test('notebook-team3 derives an isolated userData path and backend-quality profile', () => {
  const config = instanceConfig(
    ['electron', '.', '--instance=notebook-team3', '--agent-profile=backend-quality'],
    '/tmp/mcf-user-data',
  );

  assert.equal(config.id, 'notebook-team3');
  assert.equal(config.agentProfile, 'backend-quality');
  assert.equal(config.userData, path.join('/tmp/mcf-user-data', 'instances', 'notebook-team3'));
});

test('backend-quality runtime bootstraps Renato/Eduardo and routes each mission to its bound pane', async () => {
  const sent = [];
  let state = null;
  const urls = {
    chat: 'https://chatgpt.test/g/renato',
    workspace: 'https://chatgpt.test/g/eduardo',
  };

  const broker = {
    listAgents: async () => canonical,
    createSession: async ({ agentId }) => sessionFor(agentId),
    showSession: async sessionId => sessionFor(
      sessionId.includes('renato') ? 'Renato' : 'Eduardo'
    ),
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: pane => urls[pane],
    freshConversation: async () => {},
    sendMessage: async (pane, message) => {
      sent.push({ pane, message });
      return {
        ok: true,
        pane,
        method: 'button',
        deliveryConfirmed: true,
        composerCleared: true,
        conversationAdvanced: true,
        userMessageId: 'user-' + pane + '-' + sent.length,
        baselineAssistantMessageId: 'assistant-before-' + pane,
        url: urls[pane] + '/c/' + sent.length,
      };
    },
    waitForAssistantMarker: async () => true,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team3',
    missionId,
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });

  const boot = await runtime.bootstrap();
  assert.equal(boot.ok, true);
  assert.equal(state.bindings.chat.agentId, 'Renato');
  assert.equal(state.bindings.workspace.agentId, 'Eduardo');

  sent.length = 0;
  const backend = await runtime.dispatchMission({
    agentId: 'Eduardo',
    missionId: 'TEAM3-BACKEND-1',
    objective: 'Validar roteamento backend.',
  });
  assert.equal(backend.ok, true);
  assert.equal(backend.envelope.agent.pane, 'workspace');
  await runtime.waitForPendingMissions();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, 'workspace');
  assert.match(sent[0].message, /"agentId": "Eduardo"/);
  assert.equal(runtime.getMission(backend.envelope.envelopeId).state, 'ACCEPTED');

  sent.length = 0;
  const quality = await runtime.dispatchMission({
    agentId: 'Renato',
    missionId: 'TEAM3-QUALITY-1',
    objective: 'Validar roteamento de qualidade.',
  });
  assert.equal(quality.ok, true);
  assert.equal(quality.envelope.agent.pane, 'chat');
  await runtime.waitForPendingMissions();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].pane, 'chat');
  assert.match(sent[0].message, /"agentId": "Renato"/);
  assert.equal(runtime.getMission(quality.envelope.envelopeId).state, 'ACCEPTED');

  await assert.rejects(
    runtime.dispatchMission({
      agentId: 'Rafael',
      missionId: 'TEAM3-CROSS-PROFILE',
      objective: 'Não deve rotear agente de outro profile.',
    }),
    /unknown_canonical_agent/,
  );
});


test('backend-quality rejects a fresh session whose canonical identity digest does not match before any bootstrap send', async () => {
  let state = null;
  let freshCalls = 0;
  let sendCalls = 0;
  let markerCalls = 0;
  const mismatched = {
    ...sessionFor('Renato'),
    sessionId: 'session-renato-mismatched',
    contractDigest: 'f'.repeat(64),
  };
  const broker = {
    listAgents: async () => canonical,
    createSession: async () => mismatched,
  };
  const surface = {
    getUrl: () => 'https://chatgpt.test/g/renato',
    freshConversation: async () => { freshCalls += 1; },
    sendMessage: async () => {
      sendCalls += 1;
      return { ok: true };
    },
    waitForAssistantMarker: async () => {
      markerCalls += 1;
      return true;
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team3',
    missionId,
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => state,
    saveState: next => { state = structuredClone(next); },
  });

  const result = await runtime.bootstrap({ agentId: 'Renato' });
  assert.equal(result.ok, false);
  assert.equal(result.agents[0].error, 'identity_session_mismatch');
  assert.equal(freshCalls, 0);
  assert.equal(sendCalls, 0);
  assert.equal(markerCalls, 0);
  assert.equal(state.bindings.chat.state, 'ERROR');
  assert.equal(state.bindings.chat.handshakeVerified, false);
  assert.equal(state.bindings.chat.sessionId, undefined);
  assert.equal(runtime.listReceipts().some(receipt => receipt.kind === 'HANDSHAKE_VERIFIED'), false);
});

test('backend-quality never reuses a persisted READY session whose canonical digest changed', async () => {
  let createCalls = 0;
  let showCalls = 0;
  let freshCalls = 0;
  let sendCalls = 0;
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook-team3',
    missionId,
    bindings: {
      chat: {
        pane: 'chat',
        agentId: 'Renato',
        role: 'Qualidade e Testes',
        contractRef: 'docs/agentes/RENATO.md',
        contractDigest: '1'.repeat(64),
        sessionId: 'session-renato-old',
        traceId: 'trace-renato-old',
        state: 'READY',
        handshakeVerified: true,
        chatUrl: 'https://chatgpt.test/g/renato',
      },
    },
    missions: {},
    receipts: [],
  };
  const broker = {
    listAgents: async () => canonical,
    showSession: async () => {
      showCalls += 1;
      return {
        ...sessionFor('Renato'),
        sessionId: 'session-renato-old',
        contractDigest: 'f'.repeat(64),
      };
    },
    createSession: async ({ agentId }) => {
      createCalls += 1;
      return {
        ...sessionFor(agentId),
        sessionId: 'session-renato-revalidated',
      };
    },
    markOpen: async () => ({ ok: true }),
  };
  const surface = {
    getUrl: () => 'https://chatgpt.test/g/renato',
    freshConversation: async () => { freshCalls += 1; },
    sendMessage: async () => {
      sendCalls += 1;
      return {
        ok: true,
        method: 'button',
        url: 'https://chatgpt.test/g/renato/c/revalidated',
      };
    },
    waitForAssistantMarker: async () => true,
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team3',
    missionId,
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
  });

  const result = await runtime.bootstrap({ agentId: 'Renato' });
  assert.equal(result.ok, true);
  assert.equal(result.agents[0].reused, false);
  assert.equal(showCalls, 1);
  assert.equal(createCalls, 1);
  assert.equal(freshCalls, 1);
  assert.equal(sendCalls, 1);
  assert.equal(state.bindings.chat.sessionId, 'session-renato-revalidated');
  assert.equal(state.bindings.chat.contractDigest, '1'.repeat(64));
  assert.equal(state.bindings.chat.state, 'READY');
});

test('backend-quality rejects copied runtime state from another instance or profile before bootstrap', () => {
  const baseState = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook-team3',
    missionId,
    bindings: {
      chat: {
        agentId: 'Renato',
        role: 'Qualidade e Testes',
        contractRef: 'docs/agentes/RENATO.md',
      },
      workspace: {
        agentId: 'Eduardo',
        role: 'Engenharia Backend',
        contractRef: 'docs/agentes/EDUARDO.md',
      },
    },
    missions: {},
    receipts: [],
  };
  const common = {
    instanceId: 'notebook-team3',
    missionId,
    broker: { listAgents: async () => canonical },
    surface: {},
    agentBindings: bindings,
    saveState: () => {},
  };

  assert.throws(() => new PaneAgentRuntime({
    ...common,
    loadState: () => ({ ...structuredClone(baseState), instanceId: 'notebook-team2' }),
  }), /agent_runtime_instance_mismatch/);

  assert.throws(() => new PaneAgentRuntime({
    ...common,
    loadState: () => ({ ...structuredClone(baseState), missionId: 'MCF-DUAL-BROWSER-TEAM-EXPANSION-003' }),
  }), /agent_runtime_profile_mismatch/);
});


test('backend-quality startup recovers before rebootstrap and keeps operational APIs gated until revalidation finishes', async () => {
  const order = [];
  let createCalls = 0;
  let sendCalls = 0;
  let showCalls = 0;
  let releaseRecovery;
  const recoveryGate = new Promise(resolve => { releaseRecovery = resolve; });
  let state = {
    schema: 'mcf-pane-agent-runtime/v1',
    version: 2,
    instanceId: 'notebook-team3',
    missionId,
    bindings: {
      chat: {
        pane: 'chat',
        agentId: 'Renato',
        role: 'Qualidade e Testes',
        contractRef: 'docs/agentes/RENATO.md',
        contractDigest: '1'.repeat(64),
        sessionId: 'stale-renato',
        traceId: 'stale-trace-renato',
        state: 'READY',
        handshakeVerified: true,
        chatUrl: 'https://chatgpt.test/g/renato/stale',
      },
      workspace: {
        pane: 'workspace',
        agentId: 'Eduardo',
        role: 'Engenharia Backend',
        contractRef: 'docs/agentes/EDUARDO.md',
        contractDigest: '2'.repeat(64),
        sessionId: 'stale-eduardo',
        traceId: 'stale-trace-eduardo',
        state: 'READY',
        handshakeVerified: true,
        chatUrl: 'https://chatgpt.test/g/eduardo/stale',
      },
    },
    missions: {},
    receipts: [],
  };
  const broker = {
    listAgents: async () => {
      order.push('registry');
      return canonical;
    },
    showSession: async () => {
      showCalls += 1;
      throw new Error('persisted READY must not be reused during startup');
    },
    createSession: async ({ agentId }) => {
      createCalls += 1;
      order.push('create-' + agentId);
      return {
        ...sessionFor(agentId),
        sessionId: 'revalidated-' + agentId.toLowerCase(),
      };
    },
    markOpen: async sessionId => {
      order.push('open-' + sessionId);
      return { ok: true };
    },
  };
  const surface = {
    getUrl: pane => 'https://chatgpt.test/' + pane + '/current',
    freshConversation: async pane => {
      order.push('fresh-' + pane);
    },
    sendMessage: async (pane) => {
      sendCalls += 1;
      order.push('send-' + pane);
      return {
        ok: true,
        pane,
        method: 'button',
        url: 'https://chatgpt.test/' + pane + '/current',
      };
    },
    waitForAssistantMarker: async pane => {
      order.push('ready-' + pane);
      return true;
    },
  };

  const runtime = new PaneAgentRuntime({
    instanceId: 'notebook-team3',
    missionId,
    broker,
    surface,
    agentBindings: bindings,
    loadState: () => structuredClone(state),
    saveState: next => { state = structuredClone(next); },
    startupReady: false,
  });

  const before = runtime.getIdentities();
  assert.equal(runtime.isStartupReady(), false);
  assert.equal(before.find(item => item.pane === 'chat').state, 'STALE');
  assert.equal(before.find(item => item.pane === 'workspace').state, 'STALE');
  assert.equal(before.every(item => item.handshakeVerified === false), true);

  runtime.recoverPersistedMissions = async () => {
    order.push('recovery-start');
    await recoveryGate;
    order.push('recovery-end');
    return { ok: true, recovered: [] };
  };

  const startupPromise = runtime.initializeStartup();
  await new Promise(resolve => setImmediate(resolve));

  const blockedBootstrap = await runtime.bootstrap();
  assert.equal(blockedBootstrap.ok, false);
  assert.equal(blockedBootstrap.error, 'agent_runtime_initializing');

  const blockedMission = await runtime.dispatchMission({
    agentId: 'Eduardo',
    missionId: 'TEAM3-BLOCKED-DURING-RECOVERY',
    objective: 'Não pode enviar durante recovery.',
  });
  assert.equal(blockedMission.ok, false);
  assert.equal(blockedMission.error, 'agent_runtime_initializing');
  assert.deepEqual(order, ['recovery-start']);
  assert.equal(createCalls, 0);
  assert.equal(sendCalls, 0);

  releaseRecovery();
  const startup = await startupPromise;

  assert.equal(startup.ok, true);
  assert.equal(startup.startupReady, true);
  assert.equal(runtime.isStartupReady(), true);
  assert.equal(order[0], 'recovery-start');
  assert.equal(order[1], 'recovery-end');
  assert.equal(order[2], 'registry');
  assert.equal(createCalls, 2);
  assert.equal(showCalls, 0);
  assert.equal(sendCalls, 2);

  const after = runtime.getIdentities();
  assert.equal(after.find(item => item.pane === 'chat').sessionId, 'revalidated-renato');
  assert.equal(after.find(item => item.pane === 'workspace').sessionId, 'revalidated-eduardo');
  assert.equal(after.every(item => item.state === 'READY'), true);
  assert.equal(after.every(item => item.handshakeVerified === true), true);
  assert.equal(state.bindings.chat.contractDigest, '1'.repeat(64));
  assert.equal(state.bindings.workspace.contractDigest, '2'.repeat(64));
});
