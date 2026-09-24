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
