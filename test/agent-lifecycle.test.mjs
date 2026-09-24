import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  MISSION_EXECUTION_STATES,
  transitionMissionState,
  createResultCapture,
  verifyResultCapture,
  parentMissionStatus,
} from '../src/main/agent-lifecycle.mjs';

const base = {
  envelopeId: 'env-1',
  missionId: 'MISSION-1',
  parentMissionId: 'PARENT-1',
  executionId: 'exec-1',
  agentId: 'Emily',
  pane: 'chat',
  sessionId: 'session-emily',
  traceId: 'trace-emily',
  envelopeDigest: 'a'.repeat(64),
  state: 'QUEUED',
  revision: 1,
};

test('mission lifecycle forbids ACCEPTED -> COMPLETED shortcut', () => {
  let record = transitionMissionState(base, 'DELIVERED', { at: '2026-09-24T07:00:00.000Z' });
  record = transitionMissionState(record, 'ACCEPTED', { at: '2026-09-24T07:00:01.000Z' });
  assert.throws(
    () => transitionMissionState(record, 'COMPLETED', { at: '2026-09-24T07:00:02.000Z' }),
    /invalid_mission_transition/,
  );

  record = transitionMissionState(record, 'WORKING', { at: '2026-09-24T07:00:02.000Z' });
  assert.equal(record.state, MISSION_EXECUTION_STATES.WORKING);
});

test('result capture requires positive terminal proof, full assistant message identity and stable digest', () => {
  assert.throws(() => createResultCapture({
    record: { ...base, state: 'WORKING' },
    result: {
      generationFinished: false,
      terminalSignal: 'quiet_period',
      assistantMessageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'resultado',
    },
    marker: 'MCF_MISSION_ACCEPTED envelope_id=env-1 agent_id=Emily',
  }), /result_not_terminal/);

  assert.throws(() => createResultCapture({
    record: { ...base, state: 'WORKING' },
    result: {
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'request-placeholder-request-conv-1-0',
      conversationId: 'conv-1',
      text: 'Pensando',
    },
  }), /result_placeholder_not_terminal/);

  const capture = createResultCapture({
    record: { ...base, state: 'WORKING' },
    result: {
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'msg-1',
      conversationId: 'conv-1',
      text: 'MCF_MISSION_ACCEPTED envelope_id=env-1 agent_id=Emily\\nResultado final completo.',
      url: 'https://chatgpt.test/c/conv-1',
    },
    marker: 'MCF_MISSION_ACCEPTED envelope_id=env-1 agent_id=Emily',
    capturedAt: '2026-09-24T07:00:03.000Z',
  });

  assert.equal(capture.assistantMessageId, 'msg-1');
  assert.equal(capture.conversationId, 'conv-1');
  assert.match(capture.resultSha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyResultCapture(capture), true);
  assert.equal(verifyResultCapture({ ...capture, text: capture.text + 'mutated' }), false);
  assert.equal(verifyResultCapture({
    ...capture,
    assistantMessageId: 'request-placeholder-request-conv-1-0',
  }), false);
  assert.equal(verifyResultCapture({
    ...capture,
    text: 'Pensando',
    resultSha256: createHash('sha256').update('Pensando').digest('hex'),
  }), false);
  assert.equal(verifyResultCapture({
    ...capture,
    terminalProof: {
      ...capture.terminalProof,
      finalActionsObserved: false,
      stableForMs: 200,
    },
  }), false);
});

test('parent mission remains blocked until every required execution is COMPLETED', () => {
  const missions = [
    { ...base, envelopeId: 'env-emily', state: 'COMPLETED', required: true },
    { ...base, envelopeId: 'env-sofia', agentId: 'Sofia', pane: 'workspace', state: 'WORKING', required: true },
  ];

  const blocked = parentMissionStatus('PARENT-1', missions);
  assert.equal(blocked.closable, false);
  assert.equal(blocked.active, 1);
  assert.equal(blocked.completed, 1);

  const done = parentMissionStatus('PARENT-1', missions.map(x => ({ ...x, state: 'COMPLETED' })));
  assert.equal(done.closable, true);
  assert.equal(done.active, 0);
  assert.equal(done.completed, 2);
});


test('substantive final result may discuss interrupted reasoning without being classified as interrupted', () => {
  const record = {
    ...base,
    state: 'WORKING',
    acceptedAssistantStartMessageId: 'assistant-final',
    acceptedAssistantMessageId: 'assistant-final',
    delivery: { userMessageId: 'user-1' },
  };
  const capture = createResultCapture({
    record,
    result: {
      generationFinished: true,
      generationActive: false,
      terminalSignal: 'ui_generation_inactive_with_final_actions',
      finalActionsObserved: true,
      stableForMs: 1500,
      assistantMessageId: 'assistant-final',
      linkedUserMessageId: 'user-1',
      conversationId: 'conv-1',
      text: 'Relatório final: se a interface mostrar Raciocínio interrompido, a missão deve entrar em INTERRUPTED. Este texto é apenas uma explicação do requisito.',
      url: 'https://chatgpt.test/c/conv-1',
    },
  });

  assert.equal(capture.assistantMessageId, 'assistant-final');
  assert.equal(verifyResultCapture(capture), true);
});
