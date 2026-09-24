import { createHash, randomUUID } from 'node:crypto';

export const MISSION_EXECUTION_STATES = Object.freeze({
  QUEUED: 'QUEUED',
  DELIVERED: 'DELIVERED',
  ACCEPTED: 'ACCEPTED',
  WORKING: 'WORKING',
  RESULT_CAPTURED: 'RESULT_CAPTURED',
  COMPLETED: 'COMPLETED',
  INTERRUPTED: 'INTERRUPTED',
  RECOVERING: 'RECOVERING',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  UNVERIFIED: 'UNVERIFIED',
  CANCELLED_BY_AUTHORITY: 'CANCELLED_BY_AUTHORITY',
});

const TRANSITIONS = Object.freeze({
  QUEUED: new Set(['DELIVERED', 'INTERRUPTED', 'FAILED', 'CANCELLED_BY_AUTHORITY']),
  DELIVERED: new Set(['ACCEPTED', 'INTERRUPTED', 'FAILED', 'UNVERIFIED', 'CANCELLED_BY_AUTHORITY']),
  ACCEPTED: new Set(['WORKING', 'RESULT_CAPTURED', 'INTERRUPTED', 'FAILED', 'UNVERIFIED', 'CANCELLED_BY_AUTHORITY']),
  WORKING: new Set(['RESULT_CAPTURED', 'INTERRUPTED', 'FAILED', 'UNVERIFIED', 'CANCELLED_BY_AUTHORITY']),
  RESULT_CAPTURED: new Set(['COMPLETED', 'FAILED', 'UNVERIFIED']),
  INTERRUPTED: new Set(['RECOVERING', 'FAILED', 'CANCELLED_BY_AUTHORITY']),
  RECOVERING: new Set(['WORKING', 'RESULT_CAPTURED', 'FAILED', 'UNVERIFIED', 'CANCELLED_BY_AUTHORITY']),
  REJECTED: new Set([]),
  FAILED: new Set([]),
  UNVERIFIED: new Set(['RECOVERING', 'FAILED', 'CANCELLED_BY_AUTHORITY']),
  CANCELLED_BY_AUTHORITY: new Set([]),
  COMPLETED: new Set([]),
});

const STRONG_TERMINAL_SIGNALS = new Set([
  'transport_end_event',
  'ui_generation_inactive_with_final_actions',
  'recovered_terminal_message',
]);

function sha256Text(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function newExecutionId() {
  return randomUUID();
}

export function transitionMissionState(record, nextState, {
  at = new Date().toISOString(),
  evidence = null,
} = {}) {
  if (!record || !record.state || !TRANSITIONS[record.state]) {
    throw new Error('invalid_mission_record');
  }
  if (!TRANSITIONS[record.state].has(nextState)) {
    throw new Error('invalid_mission_transition:' + record.state + '->' + nextState);
  }
  return {
    ...record,
    state: nextState,
    revision: Number(record.revision || 0) + 1,
    updatedAt: at,
    lastTransition: {
      from: record.state,
      to: nextState,
      at,
      evidence,
    },
  };
}

export function createResultCapture({
  record,
  result,
  marker = null,
  capturedAt = new Date().toISOString(),
}) {
  if (!record || !['ACCEPTED', 'WORKING', 'RECOVERING'].includes(record.state)) {
    throw new Error('result_capture_invalid_state');
  }
  if (!result?.generationFinished || result?.generationActive === true) {
    throw new Error('result_not_terminal');
  }
  const terminalSignal = String(result?.terminalSignal || '');
  if (!STRONG_TERMINAL_SIGNALS.has(terminalSignal)) {
    throw new Error('result_terminal_signal_insufficient');
  }
  if (terminalSignal === 'ui_generation_inactive_with_final_actions'
      && (!result?.finalActionsObserved || Number(result?.stableForMs || 0) < 1200)) {
    throw new Error('result_terminal_proof_insufficient');
  }

  const text = String(result?.text || '');
  const normalizedText = text.trim();
  if (!normalizedText) throw new Error('result_body_missing');

  const assistantMessageId = String(result?.assistantMessageId || '').trim();
  const conversationId = String(result?.conversationId || '').trim();
  if (!assistantMessageId || !conversationId) {
    throw new Error('result_identity_missing');
  }
  if (assistantMessageId.startsWith('request-placeholder-')) {
    throw new Error('result_placeholder_not_terminal');
  }
  if (result?.interrupted === true
      || /^(pensando|thinking)(?:\.{0,3})?$/i.test(normalizedText)
      || /^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(normalizedText)) {
    throw new Error('result_interrupted_or_transient');
  }

  const acceptedAssistantStartMessageId = String(
    record?.acceptedAssistantStartMessageId
    || record?.acceptedAssistantMessageId
    || ''
  ).trim();
  const deliveredUserMessageId = String(record?.delivery?.userMessageId || '').trim();
  const linkedUserMessageId = String(result?.linkedUserMessageId || deliveredUserMessageId || '').trim();
  const assistantIdMigratedFrom = String(result?.assistantIdMigratedFrom || '').trim();

  let acceptedAssistantMessageId = acceptedAssistantStartMessageId || assistantMessageId;
  if (acceptedAssistantStartMessageId && assistantMessageId !== acceptedAssistantStartMessageId) {
    const migrationValid = assistantIdMigratedFrom === acceptedAssistantStartMessageId
      && deliveredUserMessageId
      && linkedUserMessageId === deliveredUserMessageId;
    if (!migrationValid) {
      throw new Error('result_assistant_message_mismatch');
    }
    acceptedAssistantMessageId = assistantMessageId;
  }

  const expectedMarker = String(marker || '');
  const acceptanceMarkerObserved = Boolean(expectedMarker && text.includes(expectedMarker));
  const body = acceptanceMarkerObserved
    ? text.slice(text.indexOf(expectedMarker) + expectedMarker.length).trim()
    : text.trim();
  if (!body) throw new Error('result_body_missing');

  const resultSha256 = sha256Text(text);
  return Object.freeze({
    schema: 'mcf-agent-result/v1',
    envelopeId: record.envelopeId,
    missionId: record.missionId,
    parentMissionId: record.parentMissionId ?? null,
    executionId: record.executionId,
    agentId: record.agentId,
    pane: record.pane,
    sessionId: record.sessionId,
    traceId: record.traceId,
    envelopeDigest: record.envelopeDigest,
    conversationId,
    assistantMessageId,
    acceptedAssistantStartMessageId: acceptedAssistantStartMessageId || assistantMessageId,
    acceptedAssistantMessageId: acceptedAssistantMessageId || assistantMessageId,
    linkedUserMessageId: linkedUserMessageId || null,
    assistantIdMigratedFrom: assistantIdMigratedFrom || null,
    acceptanceMarkerObserved,
    url: result?.url ?? null,
    text,
    resultSha256,
    capturedAt,
    terminalProof: {
      generationFinished: true,
      terminalSignal: result.terminalSignal,
      generationActive: false,
      stableForMs: Number(result?.stableForMs || 0),
      finalActionsObserved: Boolean(result?.finalActionsObserved),
    },
  });
}

export function verifyResultCapture(capture) {
  if (!capture || capture.schema !== 'mcf-agent-result/v1') return false;
  if (!capture.assistantMessageId || !capture.conversationId || !capture.text) return false;
  if (String(capture.assistantMessageId).startsWith('request-placeholder-')) return false;
  const normalizedText = String(capture.text).trim();
  if (!normalizedText) return false;
  if (/^(pensando|thinking)(?:\.{0,3})?$/i.test(normalizedText)) return false;
  if (/^(racioc[ií]nio interrompido|reasoning interrupted|generation interrupted|response interrupted)$/i.test(normalizedText)) return false;
  if (!capture.terminalProof?.generationFinished) return false;
  if (capture.terminalProof?.generationActive === true) return false;
  const terminalSignal = String(capture.terminalProof?.terminalSignal || '');
  if (!STRONG_TERMINAL_SIGNALS.has(terminalSignal)) return false;
  if (terminalSignal === 'ui_generation_inactive_with_final_actions'
      && (!capture.terminalProof?.finalActionsObserved
        || Number(capture.terminalProof?.stableForMs || 0) < 1200)) {
    return false;
  }
  return sha256Text(capture.text) === capture.resultSha256;
}

export function parentMissionStatus(parentMissionId, missions) {
  const relevant = (Array.isArray(missions) ? missions : [])
    .filter(item => item?.parentMissionId === parentMissionId && item?.required !== false);

  const terminalStates = new Set([
    'COMPLETED',
    'FAILED',
    'UNVERIFIED',
    'REJECTED',
    'INTERRUPTED',
    'CANCELLED_BY_AUTHORITY',
  ]);

  const groups = new Map();
  for (const attempt of relevant) {
    const logicalId = String(attempt?.missionId || attempt?.envelopeId || '');
    if (!logicalId) continue;
    const list = groups.get(logicalId) ?? [];
    list.push(attempt);
    groups.set(logicalId, list);
  }

  const logical = [...groups.entries()].map(([missionId, attempts]) => {
    const completedAttempt = attempts.find(item => item.state === 'COMPLETED') ?? null;
    const activeAttempts = attempts.filter(item => !terminalStates.has(item.state));
    return {
      missionId,
      attempts,
      completedAttempt,
      activeAttempts,
      completed: Boolean(completedAttempt),
    };
  });

  const completed = logical.filter(item => item.completed).length;
  const activeAttempts = logical.flatMap(item => item.activeAttempts);

  const blockers = [
    ...activeAttempts.map(item => ({
      envelopeId: item.envelopeId,
      missionId: item.missionId,
      agentId: item.agentId,
      pane: item.pane,
      state: item.state,
    })),
    ...logical
      .filter(item => !item.completed && item.activeAttempts.length === 0)
      .map(item => {
        const last = item.attempts.at(-1) ?? {};
        return {
          envelopeId: last.envelopeId ?? null,
          missionId: item.missionId,
          agentId: last.agentId ?? null,
          pane: last.pane ?? null,
          state: last.state ?? 'UNRESOLVED',
        };
      }),
  ];

  return {
    parentMissionId,
    required: logical.length,
    completed,
    active: activeAttempts.length,
    attempts: relevant.length,
    closable: logical.length > 0
      && completed === logical.length
      && activeAttempts.length === 0,
    blockers,
  };
}
