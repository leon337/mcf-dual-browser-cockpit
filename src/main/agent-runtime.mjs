import {
  agentBindingForPane,
  paneForAgent,
  validateCanonicalAgent,
  buildIdentityBootstrap,
  createMissionEnvelope,
  formatMissionEnvelope,
  createAgentReceipt,
  stableSha256,
} from './agent-identity.mjs';
import {
  newExecutionId,
  transitionMissionState,
  createResultCapture,
  verifyResultCapture,
  parentMissionStatus,
} from './agent-lifecycle.mjs';

export const PANE_AGENT_RUNTIME_SCHEMA = 'mcf-pane-agent-runtime/v1';

const PANES = Object.freeze(['chat', 'workspace']);
const RECEIPT_LIMIT = 500;
const LIVE_RESULT_TEXT_LIMIT = 64000;
const DEFAULT_START_TIMEOUT_RECOVERY_MS = 6 * 60 * 1000;
const DEFAULT_ACTIVITY_LEASE_MS = 90 * 1000;
const DEFAULT_ASSISTANT_START_HARD_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_RESULT_HARD_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_RECONCILIATION_STABILITY_MS = 3000;
const DEFAULT_RECONCILIATION_PROBE_INTERVAL_MS = 500;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function missionIntent(value, agentId) {
  const list = input => Array.isArray(input)
    ? input.map(item => String(item).trim()).filter(Boolean)
    : [];
  return {
    missionId: value?.missionId == null ? null : String(value.missionId),
    parentMissionId: value?.parentMissionId == null ? null : String(value.parentMissionId),
    required: value?.required !== false,
    agentId,
    objective: String(value?.objective || '').trim(),
    inputs: list(value?.inputs),
    constraints: list(value?.constraints),
    expectedOutputs: list(value?.expectedOutputs),
  };
}

function initialState(instanceId, missionId) {
  return {
    schema: PANE_AGENT_RUNTIME_SCHEMA,
    version: 2,
    instanceId,
    missionId,
    bindings: {},
    missions: {},
    receipts: [],
    updatedAt: null,
  };
}

function missionLiveView(record) {
  if (!record) return null;
  const resultText = record.result?.text == null ? null : String(record.result.text);
  const exposeResultBody = record.state === 'COMPLETED';
  return {
    envelopeId: record.envelopeId ?? null,
    missionId: record.missionId ?? null,
    parentMissionId: record.parentMissionId ?? null,
    required: record.required !== false,
    executionId: record.executionId ?? null,
    agentId: record.agentId ?? null,
    role: record.role ?? null,
    pane: record.pane ?? null,
    sessionId: record.sessionId ?? null,
    traceId: record.traceId ?? null,
    state: record.state ?? null,
    revision: record.revision ?? null,
    attemptNumber: record.attemptNumber ?? 1,
    retryOfEnvelopeId: record.retryOfEnvelopeId ?? null,
    reconciliationRequired: record.reconciliationRequired === true,
    reconciliationReason: record.reconciliationReason ?? null,
    reconciledAt: record.reconciledAt ?? null,
    cancellationRequested: record.cancellationRequested === true,
    cancellationRequestedAt: record.cancellationRequestedAt ?? null,
    cancellationRequestedBy: record.cancellationRequestedBy ?? null,
    cancellationOutcome: record.cancellationOutcome ?? null,
    createdAt: record.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
    lastError: record.lastError ?? null,
    result: record.result ? {
      conversationId: record.result.conversationId ?? null,
      assistantMessageId: record.result.assistantMessageId ?? null,
      linkedUserMessageId: record.result.linkedUserMessageId ?? null,
      resultSha256: record.result.resultSha256 ?? null,
      capturedAt: record.result.capturedAt ?? null,
      url: record.result.url ?? null,
      terminalProof: clone(record.result.terminalProof ?? null),
      text: exposeResultBody ? (resultText?.slice(0, LIVE_RESULT_TEXT_LIMIT) ?? null) : null,
      textTruncated: Boolean(
        exposeResultBody
        && resultText
        && resultText.length > LIVE_RESULT_TEXT_LIMIT
      ),
      bodyAvailable: exposeResultBody,
    } : null,
  };
}

export class PaneAgentRuntime {
  constructor({
    instanceId,
    missionId,
    broker,
    surface,
    agentBindings = null,
    loadState = () => null,
    saveState = () => {},
    now = () => new Date().toISOString(),
    startupReady = true,
    onEvent = () => {},
    startTimeoutRecoveryMs = DEFAULT_START_TIMEOUT_RECOVERY_MS,
    activityLeaseMs = DEFAULT_ACTIVITY_LEASE_MS,
    assistantStartHardTimeoutMs = DEFAULT_ASSISTANT_START_HARD_TIMEOUT_MS,
    resultHardTimeoutMs = DEFAULT_RESULT_HARD_TIMEOUT_MS,
    reconciliationStabilityMs = DEFAULT_RECONCILIATION_STABILITY_MS,
    reconciliationProbeIntervalMs = DEFAULT_RECONCILIATION_PROBE_INTERVAL_MS,
  }) {
    if (!instanceId || !missionId || !broker || !surface) {
      throw new Error('invalid_agent_runtime_configuration');
    }
    this.instanceId = instanceId;
    this.missionId = missionId;
    this.broker = broker;
    this.surface = surface;
    this.agentBindings = agentBindings || undefined;
    for (const pane of PANES) agentBindingForPane(pane, this.agentBindings);
    this.loadState = loadState;
    this.saveState = saveState;
    this.now = now;
    this.startupReady = Boolean(startupReady);
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.startTimeoutRecoveryMs = Math.max(0, Number(startTimeoutRecoveryMs) || 0);
    this.activityLeaseMs = Math.max(250, Number(activityLeaseMs) || DEFAULT_ACTIVITY_LEASE_MS);
    this.assistantStartHardTimeoutMs = Math.max(1000, Number(assistantStartHardTimeoutMs) || DEFAULT_ASSISTANT_START_HARD_TIMEOUT_MS);
    this.resultHardTimeoutMs = Math.max(1000, Number(resultHardTimeoutMs) || DEFAULT_RESULT_HARD_TIMEOUT_MS);
    this.reconciliationStabilityMs = Math.max(0, Number(reconciliationStabilityMs) || 0);
    this.reconciliationProbeIntervalMs = Math.max(25, Number(reconciliationProbeIntervalMs) || DEFAULT_RECONCILIATION_PROBE_INTERVAL_MS);
    this.missionTasks = new Map();
    this.paneMissionQueues = new Map();
    const loaded = loadState();
    if (loaded?.schema === PANE_AGENT_RUNTIME_SCHEMA) {
      for (const pane of PANES) {
        const persistedAgentId = loaded?.bindings?.[pane]?.agentId;
        const configuredAgentId = agentBindingForPane(pane, this.agentBindings).agentId;
        if (persistedAgentId && persistedAgentId !== configuredAgentId) {
          throw new Error('agent_binding_profile_mismatch');
        }
      }
    }
    this.state = loaded?.schema === PANE_AGENT_RUNTIME_SCHEMA
      ? {
          ...initialState(instanceId, missionId),
          ...loaded,
          version: 2,
          instanceId,
          missionId,
          bindings: loaded.bindings ?? {},
          missions: loaded.missions ?? {},
          receipts: Array.isArray(loaded.receipts) ? loaded.receipts.slice(-RECEIPT_LIMIT) : [],
        }
      : initialState(instanceId, missionId);
    this.#markRestartInterruptions();
  }

  #markRestartInterruptions() {
    let changed = false;
    for (const [envelopeId, record] of Object.entries(this.state.missions ?? {})) {
      if (['QUEUED', 'DELIVERED', 'ACCEPTED', 'WORKING'].includes(record?.state)) {
        const blockedRecord = {
          ...record,
          reconciliationRequired: true,
          reconciliationReason: 'runtime_restart_execution_uncertain',
        };
        this.state.missions[envelopeId] = transitionMissionState(blockedRecord, 'INTERRUPTED', {
          at: this.now(),
          evidence: {
            reason: 'runtime_restart',
            previousState: record.state,
            reconciliationRequired: true,
          },
        });
        changed = true;
      } else if (record?.state === 'RECOVERING') {
        const blockedRecord = {
          ...record,
          reconciliationRequired: true,
          reconciliationReason: 'restart_during_recovery',
          recoveryResumeRequired: true,
        };
        this.state.missions[envelopeId] = transitionMissionState(blockedRecord, 'UNVERIFIED', {
          at: this.now(),
          evidence: {
            reason: 'restart_during_recovery',
            reconciliationRequired: true,
          },
        });
        changed = true;
      }
    }
    if (changed) this.#persist();
  }

  #persist() {
    this.state.updatedAt = this.now();
    this.state.receipts = this.state.receipts.slice(-RECEIPT_LIMIT);
    this.saveState(clone(this.state));
  }

  #emit(type, payload = {}) {
    try {
      this.onEvent({
        type,
        timestamp: this.now(),
        source: 'PaneAgentRuntime',
        authority: 'authoritative',
        ...clone(payload),
      });
    } catch {
      // Observability must never change mission semantics.
    }
  }

  #record(receipt) {
    this.state.receipts.push(receipt);
    this.#persist();
    this.#emit('AGENT_RECEIPT', {
      receipt: {
        receiptId: receipt.receiptId ?? null,
        kind: receipt.kind ?? null,
        status: receipt.status ?? null,
        createdAt: receipt.createdAt ?? null,
        agent: clone(receipt.agent ?? null),
        session: clone(receipt.session ?? null),
        envelope: clone(receipt.envelope ?? null),
        evidence: clone(receipt.evidence ?? null),
      },
    });
    return receipt;
  }

  listReceipts() {
    return clone(this.state.receipts);
  }

  isStartupReady() {
    return this.startupReady;
  }

  markStartupReady() {
    this.startupReady = true;
    return { ok: true, ready: true, startupReady: true };
  }

  markStartupInitializing() {
    this.startupReady = false;
    return { ok: true, ready: false };
  }

  listMissions() {
    return clone(Object.values(this.state.missions ?? {}));
  }

  getMission(envelopeId) {
    return clone(this.state.missions?.[envelopeId] ?? null);
  }

  async requestMissionCancellation({
    envelopeId,
    authority = 'LEANDRO',
    reason = null,
  } = {}) {
    const id = String(envelopeId || '').trim();
    const normalizedAuthority = String(authority || '').trim();
    if (!id) return { ok: false, error: 'envelope_id_required' };
    if (!['LEANDRO', 'MESTRE'].includes(normalizedAuthority)) {
      return { ok: false, error: 'valid_cancellation_authority_required' };
    }
    const record = this.state.missions?.[id];
    if (!record) return { ok: false, error: 'mission_not_found', envelopeId: id };
    if (record.state === 'COMPLETED') {
      return { ok: false, error: 'mission_already_completed', envelopeId: id, state: record.state };
    }
    if (record.state === 'CANCELLED_BY_AUTHORITY') {
      return {
        ok: true,
        deduplicated: true,
        envelopeId: id,
        state: record.state,
        cancellationRequested: true,
        cancellationOutcome: record.cancellationOutcome ?? 'cancelled_execution_inactive_confirmed',
      };
    }
    if (['FAILED', 'REJECTED'].includes(record.state)) {
      return { ok: false, error: 'mission_not_cancellable', envelopeId: id, state: record.state };
    }
    if (record.cancellationRequested === true) {
      return {
        ok: true,
        deduplicated: true,
        envelopeId: id,
        state: record.state,
        cancellationRequested: true,
        reconciliationRequired: record.reconciliationRequired === true,
        cancellationSignal: clone(record.cancellationSignal ?? null),
      };
    }

    const requestedAt = this.now();
    const updated = this.#storeMission({
      ...record,
      cancellationRequested: true,
      cancellationRequestedAt: requestedAt,
      cancellationRequestedBy: normalizedAuthority,
      cancellationReason: reason == null ? null : String(reason),
      cancellationOutcome: 'cancel_requested',
      reconciliationRequired: true,
      reconciliationReason: 'explicit_cancel_pending_reconciliation',
    });
    const context = this.#missionContext(updated);
    this.#record(createAgentReceipt({
      kind: 'MISSION_CANCEL_REQUESTED',
      status: updated.state,
      binding: context.binding,
      session: context.session,
      envelope: context.envelope,
      evidence: {
        pane: updated.pane,
        executionId: updated.executionId,
        authority: normalizedAuthority,
        reason: reason == null ? null : String(reason),
        requestedAt,
        expectedConversationUrl: updated.delivery?.url ?? null,
      },
      now: requestedAt,
    }));

    let cancellationSignal = {
      ok: false,
      requested: false,
      error: 'cancel_generation_surface_unavailable',
    };
    if (updated.state === 'QUEUED' && !updated.delivery?.url) {
      cancellationSignal = {
        ok: true,
        requested: false,
        deferred: true,
        reason: 'cancel_before_delivery_deferred',
      };
    } else if (typeof this.surface.cancelAssistantGeneration === 'function') {
      cancellationSignal = await this.surface.cancelAssistantGeneration(updated.pane, {
        expectedConversationUrl: updated.delivery?.url ?? null,
        expectedUserMessageId: updated.delivery?.userMessageId ?? null,
        envelopeId: updated.envelopeId,
        executionId: updated.executionId,
      });
    }

    this.#storeMission({
      ...this.state.missions[id],
      cancellationSignal: clone(cancellationSignal),
      cancellationSignalObservedAt: this.now(),
    });
    this.#record(createAgentReceipt({
      kind: cancellationSignal?.deferred
        ? 'MISSION_CANCEL_SIGNAL_DEFERRED'
        : cancellationSignal?.ok
          ? 'MISSION_CANCEL_SIGNAL_SENT'
          : 'MISSION_CANCEL_SIGNAL_UNCONFIRMED',
      status: this.state.missions[id].state,
      binding: context.binding,
      session: context.session,
      envelope: context.envelope,
      evidence: {
        pane: updated.pane,
        executionId: updated.executionId,
        cancellationSignal: clone(cancellationSignal),
        reconciliationRequired: true,
      },
      now: this.now(),
    }));

    return {
      ok: true,
      envelopeId: id,
      state: this.state.missions[id].state,
      cancellationRequested: true,
      cancellationState: cancellationSignal?.ok
        ? 'CANCEL_REQUESTED'
        : 'CANCEL_REQUEST_UNCONFIRMED',
      cancellationSignal: clone(cancellationSignal),
      reconciliationRequired: true,
    };
  }

  async #observeStableReconciliation(record) {
    const observations = [];
    const startedAtMs = Date.now();
    const requiredStableUntilMs = startedAtMs + this.reconciliationStabilityMs;

    while (true) {
      const snapshot = await this.surface.inspectMissionExecution(record.pane, {
        expectedConversationUrl: record.delivery?.url ?? null,
        userMessageId: record.delivery?.userMessageId ?? null,
        assistantMessageId: record.acceptedAssistantMessageId ?? null,
      });
      observations.push(clone(snapshot ?? null));

      if (!snapshot?.ok || snapshot?.verified !== true) {
        return { ok: false, error: snapshot?.error ?? 'reconciliation_live_verification_failed', liveEvidence: clone(snapshot ?? null), observations };
      }
      if (snapshot.userAnchorFound === false) {
        return { ok: false, error: 'reconciliation_user_anchor_missing', liveEvidence: clone(snapshot), observations };
      }
      if (snapshot.activeExecution === true) {
        return { ok: false, error: 'mission_execution_still_active', liveEvidence: clone(snapshot), observations };
      }
      if (snapshot.lateResultObserved === true) {
        return { ok: false, error: 'late_result_recovery_required', lateResultObserved: true, liveEvidence: clone(snapshot), observations };
      }

      const nowMs = Date.now();
      if (nowMs >= requiredStableUntilMs) {
        return {
          ok: true,
          stable: true,
          stableForMs: nowMs - startedAtMs,
          sampleCount: observations.length,
          liveEvidence: clone(snapshot),
          observations,
        };
      }
      await delay(Math.min(
        this.reconciliationProbeIntervalMs,
        Math.max(1, requiredStableUntilMs - nowMs),
      ));
    }
  }

  async reconcileMission({
    envelopeId,
    outcome,
    authority = 'LEANDRO',
    evidence = null,
  } = {}) {
    const id = String(envelopeId || '').trim();
    const requestedOutcome = String(outcome || '').trim();
    const normalizedOutcome = requestedOutcome === 'cancelled_no_effect_confirmed'
      ? 'cancelled_execution_inactive_confirmed'
      : requestedOutcome;
    const normalizedAuthority = String(authority || '').trim();
    if (!id) return { ok: false, error: 'envelope_id_required' };
    if (!['no_active_execution_confirmed', 'cancelled_execution_inactive_confirmed'].includes(normalizedOutcome)) {
      return { ok: false, error: 'valid_reconciliation_outcome_required' };
    }
    if (!['LEANDRO', 'MESTRE'].includes(normalizedAuthority)) {
      return { ok: false, error: 'valid_reconciliation_authority_required' };
    }
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return { ok: false, error: 'reconciliation_evidence_required' };
    }

    let record = this.state.missions?.[id];
    if (!record) return { ok: false, error: 'mission_not_found', envelopeId: id };
    if (!['UNVERIFIED', 'INTERRUPTED'].includes(record.state)
        || record.reconciliationRequired !== true) {
      return {
        ok: false,
        error: 'mission_not_reconciliation_blocked',
        envelopeId: id,
        state: record.state,
        reconciliationRequired: record.reconciliationRequired === true,
      };
    }
    if (!record.delivery?.url || !record.delivery?.userMessageId) {
      const recoveredAnchor = await this.#recoverDeliveryAnchor(record);
      if (recoveredAnchor) {
        record = recoveredAnchor;
      } else {
        return {
          ok: false,
          error: 'mission_reconciliation_anchor_missing',
          envelopeId: id,
          state: record.state,
        };
      }
    }
    if (normalizedOutcome === 'cancelled_execution_inactive_confirmed'
        && record.cancellationRequested !== true) {
      return {
        ok: false,
        error: 'explicit_cancellation_required',
        envelopeId: id,
        state: record.state,
      };
    }
    if (typeof this.surface.inspectMissionExecution !== 'function') {
      return {
        ok: false,
        error: 'reconciliation_observation_unavailable',
        envelopeId: id,
        state: record.state,
      };
    }

    const stability = await this.#observeStableReconciliation(record);
    const liveEvidence = stability.liveEvidence ? { ...stability.liveEvidence, stableForMs: stability.stableForMs ?? null, sampleCount: stability.sampleCount ?? stability.observations?.length ?? null } : null;
    if (!liveEvidence?.ok || liveEvidence?.verified !== true) {
      return {
        ok: false,
        error: liveEvidence?.error ?? 'reconciliation_live_verification_failed',
        envelopeId: id,
        state: record.state,
        liveEvidence: clone(liveEvidence ?? null),
      };
    }
    if (liveEvidence.userAnchorFound === false) {
      return {
        ok: false,
        error: 'reconciliation_user_anchor_missing',
        envelopeId: id,
        state: record.state,
        liveEvidence: clone(liveEvidence),
      };
    }
    if (liveEvidence.activeExecution === true) {
      return {
        ok: false,
        error: 'mission_execution_still_active',
        envelopeId: id,
        state: record.state,
        liveEvidence: clone(liveEvidence),
      };
    }
    if (liveEvidence.lateResultObserved === true) {
      const context = this.#missionContext(record);
      await this.#recoverLateResultAfterStartTimeout({
        envelopeId: record.envelopeId,
        pane: record.pane,
        marker: context.marker,
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        executionId: record.executionId,
        userMessageId: record.delivery.userMessageId,
        baselineAssistantMessageId: record.delivery.baselineAssistantMessageId ?? null,
        acceptance: {
          error: 'late_result_detected_during_reconciliation',
          generationActive: false,
          url: liveEvidence.url ?? record.delivery.url,
        },
        recoveryReason: 'late_result_detected_during_reconciliation',
      });
      const recovered = this.state.missions?.[id];
      if (recovered?.state === 'COMPLETED') {
        return {
          ok: true,
          envelopeId: id,
          state: recovered.state,
          reconciliationRequired: false,
          outcome: 'late_result_validated',
          recoveredLateResult: true,
          liveEvidence: clone(liveEvidence),
        };
      }
      return {
        ok: false,
        error: 'late_result_recovery_incomplete',
        envelopeId: id,
        state: recovered?.state ?? record.state,
        reconciliationRequired: recovered?.reconciliationRequired === true,
        liveEvidence: clone(liveEvidence),
      };
    }

    if (normalizedOutcome === 'no_active_execution_confirmed'
        && liveEvidence.toolActivityObserved === true) {
      return {
        ok: false,
        error: 'external_effect_reconciliation_required',
        envelopeId: id,
        state: record.state,
        reconciliationRequired: true,
        liveEvidence: clone(liveEvidence),
      };
    }

    const reconciledAt = this.now();
    let updated = this.#storeMission({
      ...record,
      reconciliationRequired: false,
      reconciliationReason: null,
      reconciliationOutcome: normalizedOutcome,
      reconciledAt,
      reconciledBy: normalizedAuthority,
      reconciliationEvidence: {
        caller: clone(evidence),
        live: clone(liveEvidence),
      },
      cancellationOutcome: normalizedOutcome === 'cancelled_execution_inactive_confirmed'
        ? 'cancelled_execution_inactive_confirmed'
        : record.cancellationOutcome ?? null,
    });
    const context = this.#missionContext(updated);
    const receipt = this.#record(createAgentReceipt({
      kind: 'MISSION_RECONCILED',
      status: updated.state,
      binding: context.binding,
      session: context.session,
      envelope: context.envelope,
      evidence: {
        pane: updated.pane,
        executionId: updated.executionId,
        outcome: normalizedOutcome,
        authority: normalizedAuthority,
        reconciledAt,
        evidence: clone(evidence),
        liveEvidence: clone(liveEvidence),
      },
      now: reconciledAt,
    }));

    if (normalizedOutcome === 'cancelled_execution_inactive_confirmed') {
      updated = this.#transitionMission(id, 'CANCELLED_BY_AUTHORITY', {
        authority: normalizedAuthority,
        outcome: normalizedOutcome,
        reconciledAt,
      });
      this.#record(createAgentReceipt({
        kind: 'MISSION_CANCELLED_BY_AUTHORITY',
        status: 'CANCELLED_BY_AUTHORITY',
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        evidence: {
          pane: updated.pane,
          executionId: updated.executionId,
          authority: normalizedAuthority,
          outcome: normalizedOutcome,
          reconciledAt,
          liveEvidence: clone(liveEvidence),
        },
        now: reconciledAt,
      }));
    }

    return {
      ok: true,
      envelopeId: id,
      state: updated.state,
      reconciliationRequired: false,
      outcome: normalizedOutcome,
      reconciledAt,
      liveEvidence: clone(liveEvidence),
      receipt: clone(receipt),
    };
  }

  getRecoveryCheckpoint({ pane = null } = {}) {
    const normalizedPane = pane == null ? null : String(pane).trim();
    if (normalizedPane && !PANES.includes(normalizedPane)) {
      return { ok: false, error: 'valid_pane_required' };
    }
    const activeStates = new Set([
      'QUEUED',
      'DELIVERED',
      'ACCEPTED',
      'WORKING',
      'RESULT_CAPTURED',
      'RECOVERING',
    ]);
    const blockers = Object.values(this.state.missions ?? {})
      .filter(record => !normalizedPane || record?.pane === normalizedPane)
      .filter(record =>
        activeStates.has(record?.state)
        || record?.reconciliationRequired === true
        || (
          record?.cancellationRequested === true
          && !['COMPLETED', 'CANCELLED_BY_AUTHORITY', 'FAILED', 'REJECTED'].includes(record?.state)
        )
      )
      .map(record => ({
        envelopeId: record.envelopeId,
        missionId: record.missionId,
        parentMissionId: record.parentMissionId ?? null,
        agentId: record.agentId,
        pane: record.pane,
        state: record.state,
        attemptNumber: record.attemptNumber ?? 1,
        reconciliationRequired: record.reconciliationRequired === true,
        reconciliationReason: record.reconciliationReason ?? null,
        cancellationRequested: record.cancellationRequested === true,
        updatedAt: record.updatedAt ?? null,
      }));

    return {
      ok: true,
      pane: normalizedPane,
      recoveryRequired: blockers.length > 0,
      mutationAllowed: blockers.length === 0,
      blockers,
      capturedAt: this.now(),
    };
  }

  getParentMissionStatus(parentMissionId) {
    return parentMissionStatus(parentMissionId, this.listMissions());
  }

  #storeMission(record) {
    this.state.missions[record.envelopeId] = record;
    this.#persist();
    this.#emit('MISSION_STATE', {
      mission: missionLiveView(record),
    });
    return record;
  }

  #transitionMission(envelopeId, nextState, evidence = null) {
    const current = this.state.missions?.[envelopeId];
    if (!current) throw new Error('mission_record_missing');
    return this.#storeMission(transitionMissionState(current, nextState, {
      at: this.now(),
      evidence,
    }));
  }

  #missionContext(record) {
    if (!record?.pane || !record?.sessionId || !record?.envelope) {
      throw new Error('mission_recovery_context_missing');
    }
    const manifest = agentBindingForPane(record.pane, this.agentBindings);
    return {
      binding: {
        ...manifest,
        contractDigest: record.contractDigest ?? record.envelope?.agent?.contractDigest ?? null,
      },
      session: {
        sessionId: record.sessionId,
        traceId: record.traceId,
        contractDigest: record.contractDigest ?? record.envelope?.agent?.contractDigest ?? null,
      },
      envelope: record.envelope,
      marker: record.acceptanceMarker
        || ('MCF_MISSION_ACCEPTED envelope_id=' + record.envelopeId + ' agent_id=' + record.agentId),
      assistantMessageId: record.acceptedAssistantMessageId ?? null,
      userMessageId: record.delivery?.userMessageId ?? null,
    };
  }

  async #recoverDeliveryAnchor(record) {
    if (record?.delivery?.url && record?.delivery?.userMessageId) return record;
    if (!record?.envelopeId || typeof this.surface.recoverMissionDelivery !== 'function') {
      return null;
    }
    const recovered = await this.surface.recoverMissionDelivery(record.pane, {
      envelopeId: record.envelopeId,
      missionId: record.missionId,
    });
    if (!recovered?.ok || !recovered?.userMessageId || !recovered?.url) return null;

    const updated = this.#storeMission({
      ...this.state.missions[record.envelopeId],
      delivery: {
        userMessageId: recovered.userMessageId,
        baselineAssistantMessageId: recovered.baselineAssistantMessageId ?? null,
        url: recovered.url,
      },
      reconciliationRequired: true,
      reconciliationReason: this.state.missions[record.envelopeId]?.reconciliationReason
        ?? 'delivery_anchor_recovered_requires_reconciliation',
    });
    const context = this.#missionContext(updated);
    this.#record(createAgentReceipt({
      kind: 'MISSION_DELIVERY_ANCHOR_RECOVERED',
      status: updated.state,
      binding: context.binding,
      session: context.session,
      envelope: context.envelope,
      evidence: {
        pane: updated.pane,
        executionId: updated.executionId,
        userMessageId: recovered.userMessageId,
        baselineAssistantMessageId: recovered.baselineAssistantMessageId ?? null,
        url: recovered.url,
      },
      now: this.now(),
    }));
    return updated;
  }

  async #recoverLateResultAfterStartTimeout({
    envelopeId,
    pane,
    marker,
    binding,
    session,
    envelope,
    executionId,
    userMessageId,
    baselineAssistantMessageId,
    acceptance,
    recoveryReason = 'assistant_start_observation_timeout',
  }) {
    this.#storeMission({
      ...this.state.missions[envelopeId],
      reconciliationRequired: true,
      reconciliationReason: recoveryReason,
      reconciliationStartedAt: this.now(),
    });
    this.#transitionMission(envelopeId, 'RECOVERING', {
      marker,
      baselineAssistantMessageId,
      userMessageId,
      error: acceptance?.error ?? 'assistant_start_timeout',
      generationActive: acceptance?.generationActive ?? null,
      reason: recoveryReason,
    });
    this.#record(createAgentReceipt({
      kind: 'MISSION_RECOVERING',
      status: 'RECOVERING',
      binding,
      session,
      envelope,
      evidence: {
        pane,
        executionId,
        marker,
        userMessageId,
        baselineAssistantMessageId,
        observation: recoveryReason,
        generationActive: acceptance?.generationActive ?? null,
        url: acceptance?.url ?? this.surface.getUrl(pane) ?? null,
      },
      now: this.now(),
    }));

    if (typeof this.surface.waitForAssistantResult !== 'function') {
      this.#transitionMission(envelopeId, 'UNVERIFIED', {
        error: 'late_result_recovery_surface_unavailable',
        reason: recoveryReason,
      });
      return this.#record(createAgentReceipt({
        kind: 'MISSION_RESULT_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        envelope,
        evidence: {
          pane,
          executionId,
          error: 'late_result_recovery_surface_unavailable',
          reconciliationRequired: true,
          reason: recoveryReason,
        },
        now: this.now(),
      }));
    }

    const lateResult = await this.surface.waitForAssistantResult(pane, {
      marker,
      assistantMessageId: null,
      userMessageId,
      baselineAssistantMessageId,
      expectedConversationUrl: this.state.missions[envelopeId]?.delivery?.url ?? null,
      envelope,
      executionId,
      session,
      recovery: true,
      startTimeoutRecovery: true,
    }, this.startTimeoutRecoveryMs);

    if (['result_timeout', 'conversation_changed', 'conversation_anchor_lost'].includes(
      lateResult?.terminalSignal
    ) || lateResult?.interrupted || lateResult?.terminalSignal === 'assistant_interrupted') {
      const lateError = lateResult?.terminalSignal === 'result_timeout'
        ? 'late_result_recovery_timeout'
        : lateResult?.terminalSignal === 'conversation_changed'
          ? 'late_result_recovery_conversation_changed'
          : lateResult?.terminalSignal === 'conversation_anchor_lost'
            ? 'late_result_recovery_anchor_lost'
            : 'late_result_recovery_interrupted';
      this.#transitionMission(envelopeId, 'UNVERIFIED', {
        error: lateError,
        reason: recoveryReason,
        terminalSignal: lateResult?.terminalSignal ?? null,
        expectedConversationId: lateResult?.expectedConversationId ?? null,
        currentConversationId: lateResult?.currentConversationId ?? null,
      });
      return this.#record(createAgentReceipt({
        kind: 'MISSION_RESULT_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        envelope,
        evidence: {
          pane,
          executionId,
          error: lateError,
          reconciliationRequired: true,
          reason: recoveryReason,
          terminalSignal: lateResult?.terminalSignal ?? null,
          generationActive: lateResult?.generationActive ?? null,
          expectedConversationId: lateResult?.expectedConversationId ?? null,
          currentConversationId: lateResult?.currentConversationId ?? null,
          linkedUserMessageId: lateResult?.linkedUserMessageId ?? userMessageId ?? null,
          url: lateResult?.url ?? this.surface.getUrl(pane) ?? null,
        },
        now: this.now(),
      }));
    }

    let capture;
    try {
      capture = createResultCapture({
        record: this.state.missions[envelopeId],
        result: lateResult,
        marker,
        capturedAt: this.now(),
      });
    } catch (error) {
      this.#transitionMission(envelopeId, 'UNVERIFIED', {
        error: error.message,
        reason: recoveryReason,
        terminalSignal: lateResult?.terminalSignal ?? null,
      });
      return this.#record(createAgentReceipt({
        kind: 'MISSION_RESULT_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        envelope,
        evidence: {
          pane,
          executionId,
          error: error.message,
          reconciliationRequired: true,
          reason: recoveryReason,
          terminalSignal: lateResult?.terminalSignal ?? null,
          linkedUserMessageId: lateResult?.linkedUserMessageId ?? userMessageId ?? null,
          url: lateResult?.url ?? this.surface.getUrl(pane) ?? null,
        },
        now: this.now(),
      }));
    }

    const recovered = {
      ...this.state.missions[envelopeId],
      acceptedAssistantStartMessageId: capture.acceptedAssistantStartMessageId,
      acceptedAssistantMessageId: capture.acceptedAssistantMessageId,
      acceptanceMarkerObserved: capture.acceptanceMarkerObserved,
      reconciliationRequired: false,
      reconciliationReason: null,
      reconciliationOutcome: 'late_result_validated',
      reconciledAt: this.now(),
      result: capture,
    };
    this.#storeMission(transitionMissionState(recovered, 'RESULT_CAPTURED', {
      at: this.now(),
      evidence: {
        recoveredLateResult: true,
        assistantMessageId: capture.assistantMessageId,
        conversationId: capture.conversationId,
        linkedUserMessageId: capture.linkedUserMessageId ?? userMessageId ?? null,
        resultSha256: capture.resultSha256,
        terminalSignal: capture.terminalProof.terminalSignal,
      },
    }));
    this.#record(createAgentReceipt({
      kind: 'MISSION_LATE_RESULT_RECOVERED',
      status: 'RESULT_CAPTURED',
      binding,
      session,
      envelope,
      evidence: {
        pane,
        executionId,
        assistantMessageId: capture.assistantMessageId,
        conversationId: capture.conversationId,
        linkedUserMessageId: capture.linkedUserMessageId ?? userMessageId ?? null,
        resultSha256: capture.resultSha256,
        terminalSignal: capture.terminalProof.terminalSignal,
        acceptanceMarkerObserved: capture.acceptanceMarkerObserved,
        url: capture.url ?? this.surface.getUrl(pane) ?? null,
      },
      now: this.now(),
    }));

    const reloaded = this.loadState();
    const persisted = reloaded?.missions?.[envelopeId]?.result ?? null;
    const readBackValid = verifyResultCapture(persisted)
      && persisted?.resultSha256 === capture.resultSha256
      && persisted?.assistantMessageId === capture.assistantMessageId
      && persisted?.conversationId === capture.conversationId
      && persisted?.executionId === executionId
      && persisted?.envelopeId === envelopeId;

    if (!readBackValid) {
      this.#transitionMission(envelopeId, 'UNVERIFIED', {
        error: 'late_result_readback_integrity_failed',
      });
      this.#storeMission({
        ...this.state.missions[envelopeId],
        reconciliationRequired: true,
        reconciliationReason: 'late_result_readback_integrity_failed',
      });
      return this.#record(createAgentReceipt({
        kind: 'MISSION_RESULT_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        envelope,
        evidence: {
          pane,
          executionId,
          error: 'late_result_readback_integrity_failed',
          reconciliationRequired: true,
          resultSha256: capture.resultSha256,
        },
        now: this.now(),
      }));
    }

    this.#transitionMission(envelopeId, 'COMPLETED', {
      recoveredLateResult: true,
      assistantMessageId: capture.assistantMessageId,
      conversationId: capture.conversationId,
      resultSha256: capture.resultSha256,
    });
    return this.#record(createAgentReceipt({
      kind: 'MISSION_COMPLETED',
      status: 'COMPLETED',
      binding,
      session,
      envelope,
      evidence: {
        pane,
        executionId,
        recoveredLateResult: true,
        assistantMessageId: capture.assistantMessageId,
        conversationId: capture.conversationId,
        linkedUserMessageId: capture.linkedUserMessageId ?? userMessageId ?? null,
        resultSha256: capture.resultSha256,
        terminalSignal: capture.terminalProof.terminalSignal,
        url: capture.url ?? this.surface.getUrl(pane) ?? null,
      },
      now: this.now(),
    }));
  }

  getIdentities() {
    return PANES.map((pane) => {
      const manifest = agentBindingForPane(pane, this.agentBindings);
      const current = this.state.bindings[pane] ?? {};
      return {
        pane,
        agentId: manifest.agentId,
        role: manifest.role,
        contractRef: manifest.contractRef,
        contractDigest: current.contractDigest ?? null,
        sessionId: current.sessionId ?? null,
        traceId: current.traceId ?? null,
        state: current.state ?? 'UNBOUND',
        handshakeVerified: Boolean(current.handshakeVerified),
        reconciliationRequired: current.reconciliationRequired === true,
        reconciliationReason: current.reconciliationReason ?? null,
        chatUrl: current.chatUrl ?? null,
        lastError: current.lastError ?? null,
        updatedAt: current.updatedAt ?? null,
      };
    });
  }

  async #sessionForPane(pane, canonicalBinding, force) {
    const current = this.state.bindings[pane];
    if (!force
        && current?.sessionId
        && current.contractDigest === canonicalBinding.contractDigest
        && typeof this.broker.showSession === 'function') {
      try {
        const session = await this.broker.showSession(current.sessionId);
        if (session
            && session.agentId === canonicalBinding.agentId
            && session.role === canonicalBinding.role
            && session.contractRef === canonicalBinding.contractRef
            && session.contractDigest === canonicalBinding.contractDigest) {
          return { session, reused: true };
        }
      } catch {
        // Fall through to a fresh canonical session.
      }
    }

    const session = await this.broker.createSession({
      agentId: canonicalBinding.agentId,
      missionId: this.missionId,
      objective: 'Atuar como ' + canonicalBinding.agentId
        + ' no pane ' + pane
        + ', obedecendo ao contrato canônico MCF e à autoridade de LEANDRO/MESTRE.',
      surface: 'dual-browser-pane:' + pane,
    });
    return { session, reused: false };
  }

  async #freshConversationWithRetry(pane) {
    try {
      return await this.surface.freshConversation(pane);
    } catch (error) {
      const message = String(error?.message || error || '');
      const transient = message.includes('ERR_ABORTED') || message.includes('(-3)');
      if (!transient || typeof this.surface.reconcileFreshConversation !== 'function') {
        throw error;
      }

      const reconciliation = await this.surface.reconcileFreshConversation(pane);
      if (reconciliation?.ok
          && reconciliation?.fresh === true
          && reconciliation?.composerAvailable === true) {
        return {
          ...reconciliation,
          recoveredAfterUnconfirmedNavigation: true,
        };
      }

      const uncertain = new Error('fresh_conversation_outcome_unknown');
      uncertain.cause = error;
      throw uncertain;
    }
  }

  #bootstrapNeedsReconciliation(current) {
    if (!current || current.handshakeVerified === true || !current.sessionId) return false;
    return current.reconciliationRequired === true
      || current.lastError === 'message_send_unconfirmed'
      || current.state === 'RECONCILING'
      || (current.state === 'UNVERIFIED' && Boolean(current.pendingBootstrap));
  }

  async #reconcileBootstrapAttempt(pane, binding, session, current, { waitForMarker = true } = {}) {
    const marker = 'MCF_AGENT_READY agent_id=' + binding.agentId + ' session_id=' + session.sessionId;
    if (waitForMarker && typeof this.surface.waitForAssistantMarker === 'function') {
      await this.surface.waitForAssistantMarker(pane, marker);
    }

    let evidence = {
      ok: false,
      verified: false,
      error: 'identity_bootstrap_inspector_unavailable',
    };
    if (typeof this.surface.inspectIdentityBootstrap === 'function') {
      evidence = await this.surface.inspectIdentityBootstrap(pane, {
        agentId: binding.agentId,
        sessionId: session.sessionId,
        contractDigest: binding.contractDigest,
        marker,
        userMessageId: current?.pendingBootstrap?.userMessageId ?? null,
        expectedConversationUrl: current?.pendingBootstrap?.deliveryConfirmed === true
          ? current?.pendingBootstrap?.url ?? null
          : null,
        expectedProjectRoot: current?.pendingBootstrap?.expectedProjectRoot ?? null,
      });
    }

    if (!evidence?.ok
        || evidence?.verified !== true
        || evidence?.userAnchorFound !== true
        || evidence?.markerObserved !== true
        || evidence?.conflictingAttempt === true) {
      const record = this.state.bindings[pane] ?? current;
      record.state = 'RECONCILING';
      record.handshakeVerified = false;
      record.reconciliationRequired = true;
      record.reconciliationReason = record.reconciliationReason
        ?? 'identity_bootstrap_delivery_uncertain';
      record.lastError = 'identity_bootstrap_reconciliation_required';
      record.updatedAt = this.now();
      this.state.bindings[pane] = record;
      this.#persist();
      this.#record(createAgentReceipt({
        kind: 'IDENTITY_BOOTSTRAP_RECONCILIATION_PENDING',
        status: 'UNVERIFIED',
        binding,
        session,
        evidence: {
          pane,
          marker,
          reason: evidence?.error ?? 'identity_bootstrap_evidence_not_correlated',
          userAnchorFound: evidence?.userAnchorFound === true,
          markerObserved: evidence?.markerObserved === true,
          conflictingAttempt: evidence?.conflictingAttempt === true,
          url: evidence?.url ?? this.surface.getUrl(pane) ?? null,
        },
        now: this.now(),
      }));
      return {
        ok: false,
        error: 'identity_bootstrap_reconciliation_required',
        identity: clone(record),
        reconciliation: clone(evidence),
      };
    }

    const record = this.state.bindings[pane] ?? current;
    record.chatUrl = evidence.url ?? record.chatUrl ?? this.surface.getUrl(pane) ?? null;
    record.handshakeVerified = true;
    record.state = 'READY';
    record.lastError = null;
    record.reconciliationRequired = false;
    record.reconciliationReason = null;
    record.pendingBootstrap = null;
    record.updatedAt = this.now();
    this.state.bindings[pane] = record;
    this.#persist();

    if (typeof this.broker.markOpen === 'function') {
      await this.broker.markOpen(session.sessionId, record.chatUrl);
    }

    const receipt = this.#record(createAgentReceipt({
      kind: 'HANDSHAKE_VERIFIED',
      status: 'READY',
      binding,
      session,
      evidence: {
        pane,
        url: record.chatUrl,
        marker,
        reconciled: true,
        userMessageId: evidence.userMessageId ?? null,
        assistantMessageId: evidence.assistantMessageId ?? null,
      },
      now: this.now(),
    }));
    return {
      ok: true,
      reused: true,
      reconciled: true,
      identity: clone(record),
      receipt,
    };
  }

  async #bootstrapPane(pane, canonicalAgents, force) {
    const manifest = agentBindingForPane(pane, this.agentBindings);
    const canonical = canonicalAgents.find(agent => agent.agentId === manifest.agentId);
    const binding = validateCanonicalAgent(manifest, canonical);
    const current = this.state.bindings[pane];

    if (this.#bootstrapNeedsReconciliation(current)) {
      if (current.contractDigest !== binding.contractDigest) {
        return {
          ok: false,
          error: 'identity_bootstrap_reconciliation_digest_mismatch',
          identity: clone(current),
        };
      }
      if (typeof this.broker.showSession !== 'function') {
        return {
          ok: false,
          error: 'identity_bootstrap_reconciliation_session_unavailable',
          identity: clone(current),
        };
      }

      let persistedSession;
      try {
        persistedSession = await this.broker.showSession(current.sessionId);
        buildIdentityBootstrap({ binding, session: persistedSession });
      } catch {
        return {
          ok: false,
          error: 'identity_bootstrap_reconciliation_session_invalid',
          identity: clone(current),
        };
      }

      return this.#reconcileBootstrapAttempt(
        pane,
        binding,
        persistedSession,
        current,
        { waitForMarker: true },
      );
    }

    const { session, reused } = await this.#sessionForPane(pane, binding, force);

    if (!force
        && reused
        && current?.state === 'READY'
        && current.handshakeVerified
        && current.contractDigest === binding.contractDigest
        && current.chatUrl
        && this.surface.getUrl(pane) === current.chatUrl) {
      return { ok: true, reused: true, skipped: true, identity: clone(current) };
    }

    this.state.bindings[pane] = {
      pane,
      agentId: binding.agentId,
      role: binding.role,
      contractRef: binding.contractRef,
      contractDigest: binding.contractDigest,
      sessionId: session.sessionId,
      traceId: session.traceId,
      state: 'BOOTSTRAPPING',
      handshakeVerified: false,
      reconciliationRequired: false,
      reconciliationReason: null,
      pendingBootstrap: null,
      chatUrl: null,
      lastError: null,
      updatedAt: this.now(),
    };
    this.#persist();

    let freshConversation = null;
    if (!reused || force || current?.state !== 'READY') {
      freshConversation = await this.#freshConversationWithRetry(pane);
    }

    const bootstrap = buildIdentityBootstrap({ binding, session });
    const marker = 'MCF_AGENT_READY agent_id=' + binding.agentId + ' session_id=' + session.sessionId;
    const pendingBootstrap = {
      marker,
      agentId: binding.agentId,
      sessionId: session.sessionId,
      contractDigest: binding.contractDigest,
      expectedProjectRoot: freshConversation?.url ?? null,
      deliveryConfirmed: false,
      userMessageId: null,
      url: null,
      startedAt: this.now(),
    };

    const delivery = await this.surface.sendMessage(pane, bootstrap);

    if (!delivery?.ok) {
      const deliveryError = delivery?.error ?? 'identity_bootstrap_delivery_failed';
      if (deliveryError === 'message_send_unconfirmed') {
        const uncertain = this.state.bindings[pane];
        uncertain.state = 'RECONCILING';
        uncertain.handshakeVerified = false;
        uncertain.reconciliationRequired = true;
        uncertain.reconciliationReason = 'identity_bootstrap_delivery_uncertain';
        uncertain.pendingBootstrap = pendingBootstrap;
        uncertain.chatUrl = this.surface.getUrl(pane) ?? null;
        uncertain.lastError = deliveryError;
        uncertain.updatedAt = this.now();
        this.#persist();

        this.#record(createAgentReceipt({
          kind: 'IDENTITY_BOOTSTRAP_DELIVERY_UNCERTAIN',
          status: 'UNVERIFIED',
          binding,
          session,
          evidence: {
            pane,
            error: deliveryError,
            marker,
            url: uncertain.chatUrl,
            reconciliationRequired: true,
          },
          now: this.now(),
        }));

        return this.#reconcileBootstrapAttempt(
          pane,
          binding,
          session,
          uncertain,
          { waitForMarker: true },
        );
      }

      const failed = this.state.bindings[pane];
      failed.state = 'ERROR';
      failed.lastError = deliveryError;
      failed.updatedAt = this.now();
      this.#record(createAgentReceipt({
        kind: 'IDENTITY_BOOTSTRAP_DELIVERY_FAILED',
        status: 'FAILED',
        binding,
        session,
        evidence: { error: failed.lastError, pane },
        now: this.now(),
      }));
      return { ok: false, error: failed.lastError, identity: clone(failed) };
    }

    this.#record(createAgentReceipt({
      kind: 'IDENTITY_BOOTSTRAP_DELIVERED',
      status: 'DELIVERED',
      binding,
      session,
      evidence: {
        pane,
        url: delivery.url ?? this.surface.getUrl(pane) ?? null,
        method: delivery.method ?? null,
        userMessageId: delivery.userMessageId ?? null,
      },
      now: this.now(),
    }));

    const awaitingHandshake = this.state.bindings[pane];
    awaitingHandshake.chatUrl = delivery.url ?? this.surface.getUrl(pane) ?? null;
    awaitingHandshake.state = 'UNVERIFIED';
    awaitingHandshake.handshakeVerified = false;
    awaitingHandshake.reconciliationRequired = true;
    awaitingHandshake.reconciliationReason = 'identity_handshake_pending';
    awaitingHandshake.pendingBootstrap = {
      ...pendingBootstrap,
      deliveryConfirmed: true,
      userMessageId: delivery.userMessageId ?? null,
      url: delivery.url ?? null,
    };
    awaitingHandshake.lastError = 'identity_handshake_pending';
    awaitingHandshake.updatedAt = this.now();
    this.#persist();

    const verified = await this.surface.waitForAssistantMarker(pane, marker);
    const record = this.state.bindings[pane];
    record.handshakeVerified = Boolean(verified);
    record.state = verified ? 'READY' : 'UNVERIFIED';
    record.lastError = verified ? null : 'identity_handshake_not_observed';
    record.reconciliationRequired = !verified;
    record.reconciliationReason = verified ? null : 'identity_handshake_not_observed';
    if (verified) record.pendingBootstrap = null;
    record.updatedAt = this.now();
    this.#persist();

    if (!verified) {
      this.#record(createAgentReceipt({
        kind: 'HANDSHAKE_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        evidence: {
          pane,
          url: record.chatUrl,
          userMessageId: delivery.userMessageId ?? null,
          reconciliationRequired: true,
        },
        now: this.now(),
      }));
      return { ok: false, error: record.lastError, identity: clone(record) };
    }

    if (typeof this.broker.markOpen === 'function') {
      await this.broker.markOpen(session.sessionId, record.chatUrl);
    }

    const receipt = this.#record(createAgentReceipt({
      kind: 'HANDSHAKE_VERIFIED',
      status: 'READY',
      binding,
      session,
      evidence: {
        pane,
        url: record.chatUrl,
        marker,
        userMessageId: delivery.userMessageId ?? null,
      },
      now: this.now(),
    }));
    return { ok: true, reused, identity: clone(record), receipt };
  }

  async bootstrap({ agentId = null, force = false, parallel = false } = {}) {
    const registry = await this.broker.listAgents();
    const canonicalAgents = Array.isArray(registry) ? registry : registry?.agents;
    if (!Array.isArray(canonicalAgents)) throw new Error('canonical_agent_registry_unavailable');

    const panes = agentId ? [paneForAgent(agentId, this.agentBindings)] : [...PANES];

    const runPane = async pane => {
      const checkpoint = this.getRecoveryCheckpoint({ pane });
      if (checkpoint.recoveryRequired || checkpoint.mutationAllowed === false) {
        return { ok: false, error: 'pane_recovery_required', pane, checkpoint };
      }
      try {
        return await this.#bootstrapPane(pane, canonicalAgents, Boolean(force));
      } catch (error) {
        const manifest = agentBindingForPane(pane, this.agentBindings);
        const current = this.state.bindings[pane] ?? {
          pane,
          agentId: manifest.agentId,
          role: manifest.role,
          contractRef: manifest.contractRef,
        };
        current.state = 'ERROR';
        current.handshakeVerified = false;
        current.lastError = error.message;
        current.updatedAt = this.now();
        this.state.bindings[pane] = current;
        this.#persist();
        return { ok: false, error: error.message, identity: clone(current) };
      }
    };

    const results = parallel && panes.length > 1
      ? await Promise.all(panes.map(runPane))
      : await (async () => {
          const sequential = [];
          for (const pane of panes) sequential.push(await runPane(pane));
          return sequential;
        })();

    return {
      ok: results.every(result => result.ok),
      parallel: Boolean(parallel && panes.length > 1),
      agents: results,
    };
  }

  async dispatchMission(input) {
    if (!this.startupReady) {
      return {
        ok: false,
        error: 'agent_runtime_initializing',
      };
    }

    const pane = paneForAgent(input?.agentId, this.agentBindings);
    const manifest = agentBindingForPane(pane, this.agentBindings);

    const requestedMissionId = input?.missionId == null ? null : String(input.missionId);
    const requestedParentMissionId = input?.parentMissionId == null
      ? null
      : String(input.parentMissionId);
    let retryContext = null;

    if (requestedMissionId) {
      const attempts = Object.values(this.state.missions ?? {}).filter(record =>
        record?.missionId === requestedMissionId
        && record?.agentId === manifest.agentId
        && (record?.parentMissionId ?? null) === requestedParentMissionId
      );
      const existing = attempts.at(-1) ?? null;

      if (existing) {
        const requestedIntent = missionIntent(input, manifest.agentId);
        const existingIntent = missionIntent(existing.envelope, manifest.agentId);
        if (stableSha256(requestedIntent) !== stableSha256(existingIntent)) {
          return {
            ok: false,
            error: 'mission_id_conflict',
            agentId: manifest.agentId,
            pane,
            missionId: requestedMissionId,
            parentMissionId: requestedParentMissionId,
            envelopeId: existing.envelopeId,
            state: existing.state,
          };
        }

        const terminalStates = new Set([
          'COMPLETED',
          'FAILED',
          'UNVERIFIED',
          'REJECTED',
          'INTERRUPTED',
          'CANCELLED_BY_AUTHORITY',
        ]);
        const retryableStates = new Set(['FAILED', 'UNVERIFIED', 'INTERRUPTED']);
        const completedAttempt = attempts.find(record => record.state === 'COMPLETED') ?? null;
        const activeAttempt = [...attempts].reverse().find(record =>
          !terminalStates.has(record.state)
        ) ?? null;
        const retryRequested = input?.retryFailed === true;

        if (retryRequested && existing.reconciliationRequired === true) {
          return {
            ok: false,
            error: 'mission_reconciliation_required',
            agentId: manifest.agentId,
            pane,
            missionId: requestedMissionId,
            parentMissionId: requestedParentMissionId,
            envelopeId: existing.envelopeId,
            state: existing.state,
            reconciliationRequired: true,
            reconciliationReason: existing.reconciliationReason ?? null,
          };
        }

        if (retryRequested
            && !completedAttempt
            && !activeAttempt
            && retryableStates.has(existing.state)) {
          retryContext = {
            retryOfEnvelopeId: existing.envelopeId,
            attemptNumber: attempts.length + 1,
          };
        } else {
          const target = completedAttempt ?? activeAttempt ?? existing;
          const queuedReceipt = [...(this.state.receipts ?? [])].reverse().find(receipt =>
            receipt?.kind === 'MISSION_QUEUED'
            && receipt?.envelope?.envelopeId === target.envelopeId
          ) ?? null;
          const acceptanceReceipt = [...(this.state.receipts ?? [])].reverse().find(receipt =>
            receipt?.kind === 'MISSION_ACCEPTED'
            && receipt?.envelope?.envelopeId === target.envelopeId
          ) ?? null;
          return {
            ok: true,
            deduplicated: true,
            queued: target.state === 'QUEUED',
            delivered: target.state === 'QUEUED' ? null : true,
            accepted: ['ACCEPTED', 'WORKING', 'RESULT_CAPTURED', 'COMPLETED'].includes(target.state)
              ? true
              : null,
            deliveryPending: target.state === 'QUEUED',
            acceptancePending: ['QUEUED', 'DELIVERED'].includes(target.state),
            acceptanceMarker: target.acceptanceMarker ?? null,
            state: target.state,
            executionId: target.executionId,
            envelope: clone(target.envelope),
            receipt: clone(queuedReceipt),
            acceptanceReceipt: clone(acceptanceReceipt),
          };
        }
      }
    }

    const blockingStates = new Set([
      'QUEUED',
      'DELIVERED',
      'ACCEPTED',
      'WORKING',
      'RESULT_CAPTURED',
      'RECOVERING',
    ]);
    const terminalStates = new Set([
      'COMPLETED',
      'CANCELLED_BY_AUTHORITY',
      'FAILED',
      'REJECTED',
    ]);
    const paneBlocker = Object.values(this.state.missions ?? {}).find(record =>
      record?.pane === pane
      && (
        blockingStates.has(record?.state)
        || record?.reconciliationRequired === true
        || (
          record?.cancellationRequested === true
          && !terminalStates.has(record?.state)
        )
      )
    ) ?? null;
    if (paneBlocker) {
      return {
        ok: false,
        error: paneBlocker.reconciliationRequired === true
          ? 'pane_recovery_required'
          : 'pane_mission_active',
        agentId: manifest.agentId,
        pane,
        envelopeId: paneBlocker.envelopeId,
        missionId: paneBlocker.missionId,
        state: paneBlocker.state,
        reconciliationRequired: paneBlocker.reconciliationRequired === true,
        reconciliationReason: paneBlocker.reconciliationReason ?? null,
        cancellationRequested: paneBlocker.cancellationRequested === true,
      };
    }

    const current = this.state.bindings[pane];
    if (!current || current.state !== 'READY' || !current.handshakeVerified) {
      return { ok: false, error: 'agent_not_ready', agentId: manifest.agentId, pane };
    }

    const session = {
      sessionId: current.sessionId,
      traceId: current.traceId,
      contractDigest: current.contractDigest,
    };
    const binding = {
      ...manifest,
      contractDigest: current.contractDigest,
    };
    const envelope = createMissionEnvelope({
      binding,
      session,
      input,
    });
    const executionId = newExecutionId();
    const envelopeDigest = stableSha256(envelope);
    this.#storeMission({
      schema: 'mcf-agent-mission-execution/v1',
      envelopeId: envelope.envelopeId,
      missionId: envelope.missionId,
      parentMissionId: envelope.parentMissionId ?? null,
      required: envelope.required !== false,
      executionId,
      agentId: manifest.agentId,
      role: manifest.role,
      pane,
      sessionId: session.sessionId,
      traceId: session.traceId,
      contractRef: manifest.contractRef,
      contractDigest: current.contractDigest,
      envelopeDigest,
      envelope,
      attemptNumber: retryContext?.attemptNumber ?? 1,
      retryOfEnvelopeId: retryContext?.retryOfEnvelopeId ?? null,
      reconciliationRequired: false,
      reconciliationReason: null,
      reconciledAt: null,
      cancellationRequested: false,
      cancellationRequestedAt: null,
      cancellationRequestedBy: null,
      cancellationOutcome: null,
      acceptanceMarker: 'MCF_MISSION_ACCEPTED envelope_id=' + envelope.envelopeId
        + ' agent_id=' + manifest.agentId,
      state: 'QUEUED',
      revision: 1,
      createdAt: this.now(),
      updatedAt: this.now(),
      result: null,
      lastError: null,
    });

    const queuedReceipt = this.#record(createAgentReceipt({
      kind: 'MISSION_QUEUED',
      status: 'QUEUED',
      binding,
      session,
      envelope,
      evidence: {
        pane,
        executionId,
        envelopeDigest,
        attemptNumber: retryContext?.attemptNumber ?? 1,
        retryOfEnvelopeId: retryContext?.retryOfEnvelopeId ?? null,
        url: this.surface.getUrl(pane) ?? null,
      },
      now: this.now(),
    }));

    const marker = 'MCF_MISSION_ACCEPTED envelope_id=' + envelope.envelopeId
      + ' agent_id=' + manifest.agentId;
    const previous = this.paneMissionQueues.get(pane) ?? Promise.resolve();

    const missionTask = previous
      .catch(() => null)
      .then(async () => {
        const preDelivery = this.state.missions[envelope.envelopeId];
        if (preDelivery?.cancellationRequested === true) {
          this.#transitionMission(envelope.envelopeId, 'CANCELLED_BY_AUTHORITY', {
            reason: 'cancelled_before_delivery',
            authority: preDelivery.cancellationRequestedBy ?? 'LEANDRO',
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_CANCELLED_BY_AUTHORITY',
            status: 'CANCELLED_BY_AUTHORITY',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              reason: 'cancelled_before_delivery',
              authority: preDelivery.cancellationRequestedBy ?? 'LEANDRO',
              deliveryOccurred: false,
            },
            now: this.now(),
          }));
        }

        const delivery = await this.surface.sendMessage(pane, formatMissionEnvelope(envelope));
        const cancellationAfterDelivery = this.state.missions[envelope.envelopeId];
        if (delivery?.ok === true
            && delivery?.userMessageId
            && delivery?.url
            && cancellationAfterDelivery?.cancellationRequested === true
            && cancellationAfterDelivery?.cancellationSignal?.deferred === true
            && typeof this.surface.cancelAssistantGeneration === 'function') {
          const cancellationSignal = await this.surface.cancelAssistantGeneration(pane, {
            expectedConversationUrl: delivery?.url ?? null,
            expectedUserMessageId: delivery?.userMessageId ?? null,
            envelopeId: envelope.envelopeId,
            executionId,
          });
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            cancellationSignal: clone(cancellationSignal),
            cancellationSignalObservedAt: this.now(),
          });
          this.#record(createAgentReceipt({
            kind: cancellationSignal?.ok
              ? 'MISSION_CANCEL_SIGNAL_SENT'
              : 'MISSION_CANCEL_SIGNAL_UNCONFIRMED',
            status: this.state.missions[envelope.envelopeId].state,
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              cancellationSignal: clone(cancellationSignal),
              deferredUntilDelivery: true,
              reconciliationRequired: true,
              url: delivery?.url ?? this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        if (!delivery?.ok && delivery?.error === 'message_send_unconfirmed') {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: 'mission_delivery_outcome_unknown',
          });
          this.#transitionMission(envelope.envelopeId, 'INTERRUPTED', {
            error: 'mission_delivery_outcome_unknown',
            deliveryError: delivery.error,
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_DELIVERY_UNVERIFIED',
            status: 'INTERRUPTED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              error: delivery.error,
              reconciliationRequired: true,
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        if (!delivery?.ok) {
          this.#transitionMission(envelope.envelopeId, 'FAILED', {
            error: delivery?.error ?? 'mission_delivery_failed',
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_DELIVERY_FAILED',
            status: 'FAILED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              error: delivery?.error ?? 'mission_delivery_failed',
              cleanup: delivery?.cleanup ?? null,
              verification: delivery?.verification ?? null,
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        this.#transitionMission(envelope.envelopeId, 'DELIVERED', {
          url: delivery.url ?? this.surface.getUrl(pane) ?? null,
          method: delivery.method ?? null,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_DELIVERED',
          status: 'DELIVERED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            executionId,
            url: delivery.url ?? this.surface.getUrl(pane) ?? null,
            method: delivery.method ?? null,
            deliveryConfirmed: Boolean(delivery.deliveryConfirmed),
            composerCleared: Boolean(delivery.composerCleared),
            conversationAdvanced: Boolean(delivery.conversationAdvanced),
            userMessageCount: delivery.userMessageCount ?? null,
          },
          now: this.now(),
        }));

        const baselineAssistantMessageId = delivery.baselineAssistantMessageId ?? null;
        const userMessageId = delivery.userMessageId ?? null;
        this.#storeMission({
          ...this.state.missions[envelope.envelopeId],
          delivery: {
            userMessageId,
            baselineAssistantMessageId,
            url: delivery.url ?? this.surface.getUrl(pane) ?? null,
          },
        });

        let acceptance = null;
        if (typeof this.surface.waitForAssistantStart === 'function') {
          const assistantStartBeganAt = Date.now();
          const assistantStartHardDeadline = assistantStartBeganAt + this.assistantStartHardTimeoutMs;
          while (true) {
            const remainingMs = Math.max(250, assistantStartHardDeadline - Date.now());
            acceptance = await this.surface.waitForAssistantStart(pane, {
              marker,
              envelope,
              executionId,
              session,
              userMessageId,
              baselineAssistantMessageId,
            }, Math.min(60000, remainingMs));

            const nowMs = Date.now();
            const lastActivityAt = Number(acceptance?.lastActivityAt);
            const activitySeen = Boolean(
              acceptance?.generationActive === true
              || acceptance?.activityObserved === true
              || acceptance?.positiveActivityObserved === true
            );
            const activityFresh = activitySeen && (
              !Number.isFinite(lastActivityAt)
              || nowMs - lastActivityAt <= this.activityLeaseMs
            );
            const hardDeadlineReached = nowMs >= assistantStartHardDeadline;
            const positiveActivityTimeout = !acceptance?.accepted
              && !acceptance?.interrupted
              && acceptance?.error === 'assistant_start_timeout'
              && activityFresh
              && !hardDeadlineReached;

            if (!positiveActivityTimeout) {
              if (!acceptance?.accepted
                  && !acceptance?.interrupted
                  && acceptance?.error === 'assistant_start_timeout'
                  && (hardDeadlineReached || (activitySeen && !activityFresh))) {
                acceptance = {
                  ...acceptance,
                  error: hardDeadlineReached
                    ? 'assistant_start_hard_timeout'
                    : 'assistant_activity_lease_expired',
                  hardDeadlineReached,
                  activityLeaseExpired: activitySeen && !activityFresh,
                  observationElapsedMs: nowMs - assistantStartBeganAt,
                };
              }
              break;
            }

            this.#record(createAgentReceipt({
              kind: 'MISSION_ACCEPTANCE_STILL_WAITING',
              status: 'DELIVERED',
              binding,
              session,
              envelope,
              evidence: {
                pane,
                executionId,
                marker,
                userMessageId,
                baselineAssistantMessageId,
                observation: 'assistant_start_timeout_positive_activity_non_terminal',
                generationActive: Boolean(acceptance?.generationActive),
                activityObserved: Boolean(acceptance?.activityObserved),
                positiveActivityObserved: Boolean(acceptance?.positiveActivityObserved),
                lastActivityAt: acceptance?.lastActivityAt ?? null,
                activityLeaseMs: this.activityLeaseMs,
                assistantStartHardTimeoutMs: this.assistantStartHardTimeoutMs,
                observationElapsedMs: nowMs - assistantStartBeganAt,
                url: acceptance?.url ?? this.surface.getUrl(pane) ?? null,
              },
              now: this.now(),
            }));
          }
        } else if (typeof this.surface.waitForAssistantMarker === 'function') {
          const markerObserved = await this.surface.waitForAssistantMarker(pane, marker);
          acceptance = markerObserved
            ? {
                ok: true,
                accepted: true,
                assistantMessageId: null,
                markerObserved: true,
                baselineAssistantMessageId,
              }
            : { ok: false, accepted: false, markerObserved: false };
        }

        if (acceptance?.interrupted) {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: this.state.missions[envelope.envelopeId]?.cancellationRequested
              ? 'explicit_cancel_pending_reconciliation'
              : 'assistant_interrupted_requires_reconciliation',
          });
          this.#transitionMission(envelope.envelopeId, 'INTERRUPTED', {
            marker,
            baselineAssistantMessageId,
            userMessageId,
            error: acceptance?.error ?? 'assistant_interrupted',
            interruptionText: acceptance?.interruptionText ?? null,
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_INTERRUPTED',
            status: 'INTERRUPTED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              url: acceptance?.url ?? this.surface.getUrl(pane) ?? null,
              marker,
              userMessageId,
              baselineAssistantMessageId,
              error: acceptance?.error ?? 'assistant_interrupted',
              interruptionText: acceptance?.interruptionText ?? null,
            },
            now: this.now(),
          }));
        }

        if (!acceptance?.accepted && acceptance?.error === 'assistant_start_timeout') {
          return this.#recoverLateResultAfterStartTimeout({
            envelopeId: envelope.envelopeId,
            pane,
            marker,
            binding,
            session,
            envelope,
            executionId,
            userMessageId,
            baselineAssistantMessageId,
            acceptance,
          });
        }

        if (!acceptance?.accepted) {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: acceptance?.error ?? 'assistant_start_not_observed',
          });
          this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
            marker,
            baselineAssistantMessageId,
            userMessageId,
            error: acceptance?.error ?? 'assistant_start_not_observed',
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_ACCEPTANCE_UNVERIFIED',
            status: 'UNVERIFIED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              url: this.surface.getUrl(pane) ?? null,
              marker,
              userMessageId,
              baselineAssistantMessageId,
              error: acceptance?.error ?? 'assistant_start_not_observed',
            },
            now: this.now(),
          }));
        }

        const acceptedAssistantMessageId = acceptance.assistantMessageId ?? null;
        if (typeof this.surface.waitForAssistantStart === 'function' && !acceptedAssistantMessageId) {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: 'assistant_message_identity_missing',
          });
          this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
            error: 'assistant_message_identity_missing',
            markerObserved: Boolean(acceptance.markerObserved),
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_ACCEPTANCE_UNVERIFIED',
            status: 'UNVERIFIED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              url: this.surface.getUrl(pane) ?? null,
              marker,
              markerObserved: Boolean(acceptance.markerObserved),
              error: 'assistant_message_identity_missing',
            },
            now: this.now(),
          }));
        }

        this.#storeMission({
          ...this.state.missions[envelope.envelopeId],
          acceptedAssistantStartMessageId: acceptedAssistantMessageId,
          acceptedAssistantMessageId,
          acceptanceMarkerObserved: Boolean(acceptance.markerObserved),
        });

        this.#transitionMission(envelope.envelopeId, 'ACCEPTED', {
          marker,
          markerObserved: Boolean(acceptance.markerObserved),
          assistantMessageId: acceptedAssistantMessageId,
          baselineAssistantMessageId,
          userMessageId,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_ACCEPTED',
          status: 'ACCEPTED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            executionId,
            url: this.surface.getUrl(pane) ?? null,
            marker,
            markerObserved: Boolean(acceptance.markerObserved),
            assistantMessageId: acceptedAssistantMessageId,
            baselineAssistantMessageId,
            userMessageId,
          },
          now: this.now(),
        }));

        if (typeof this.surface.waitForAssistantResult !== 'function') {
          return this.getMission(envelope.envelopeId);
        }

        this.#transitionMission(envelope.envelopeId, 'WORKING', {
          marker,
          assistantMessageId: acceptedAssistantMessageId,
          observation: 'assistant_result_pending',
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_WORKING',
          status: 'WORKING',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            executionId,
            marker,
            assistantMessageId: acceptedAssistantMessageId,
            url: this.surface.getUrl(pane) ?? null,
          },
          now: this.now(),
        }));

        let result = null;
        const resultObservationBeganAt = Date.now();
        const resultHardDeadline = resultObservationBeganAt + this.resultHardTimeoutMs;
        while (true) {
          const remainingMs = Math.max(250, resultHardDeadline - Date.now());
          result = await this.surface.waitForAssistantResult(pane, {
            marker,
            assistantMessageId: acceptedAssistantMessageId,
            userMessageId,
            baselineAssistantMessageId,
            expectedConversationUrl:
              this.state.missions[envelope.envelopeId]?.delivery?.url ?? null,
            envelope,
            executionId,
            session,
          }, Math.min(120000, remainingMs));

          if (result?.terminalSignal !== 'result_timeout') break;

          const nowMs = Date.now();
          if (nowMs >= resultHardDeadline) {
            this.#storeMission({
              ...this.state.missions[envelope.envelopeId],
              reconciliationRequired: true,
              reconciliationReason: 'result_hard_timeout',
            });
            this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
              error: 'result_hard_timeout',
              terminalSignal: 'result_timeout',
              observationElapsedMs: nowMs - resultObservationBeganAt,
            });
            return this.#record(createAgentReceipt({
              kind: 'MISSION_RESULT_UNVERIFIED',
              status: 'UNVERIFIED',
              binding,
              session,
              envelope,
              evidence: {
                pane,
                executionId,
                assistantMessageId: acceptedAssistantMessageId,
                error: 'result_hard_timeout',
                terminalSignal: 'result_timeout',
                reconciliationRequired: true,
                resultHardTimeoutMs: this.resultHardTimeoutMs,
                observationElapsedMs: nowMs - resultObservationBeganAt,
                url: this.surface.getUrl(pane) ?? null,
              },
              now: this.now(),
            }));
          }

          this.#record(createAgentReceipt({
            kind: 'MISSION_STILL_WORKING',
            status: 'WORKING',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              assistantMessageId: acceptedAssistantMessageId,
              observation: 'result_observation_timeout_non_terminal',
              generationActive: result?.generationActive ?? null,
              resultHardTimeoutMs: this.resultHardTimeoutMs,
              observationElapsedMs: nowMs - resultObservationBeganAt,
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        if (['conversation_changed', 'conversation_anchor_lost'].includes(result?.terminalSignal)) {
          const observationError = result.terminalSignal === 'conversation_changed'
            ? 'conversation_changed_during_result_observation'
            : 'conversation_anchor_lost_during_result_observation';
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: observationError,
          });
          this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
            error: observationError,
            expectedConversationId: result.expectedConversationId ?? null,
            currentConversationId: result.currentConversationId ?? null,
            assistantMessageId: result.assistantMessageId ?? acceptedAssistantMessageId,
            linkedUserMessageId: result.linkedUserMessageId ?? userMessageId,
            url: result.url ?? this.surface.getUrl(pane) ?? null,
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_RESULT_UNVERIFIED',
            status: 'UNVERIFIED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              error: observationError,
              expectedConversationId: result.expectedConversationId ?? null,
              currentConversationId: result.currentConversationId ?? null,
              assistantMessageId: result.assistantMessageId ?? acceptedAssistantMessageId,
              linkedUserMessageId: result.linkedUserMessageId ?? userMessageId,
              reconciliationRequired: true,
              url: result.url ?? this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        if (result?.interrupted || result?.terminalSignal === 'assistant_interrupted') {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: this.state.missions[envelope.envelopeId]?.cancellationRequested
              ? 'explicit_cancel_pending_reconciliation'
              : 'assistant_interrupted_requires_reconciliation',
          });
          this.#transitionMission(envelope.envelopeId, 'INTERRUPTED', {
            error: 'assistant_interrupted',
            assistantMessageId: result?.assistantMessageId ?? acceptedAssistantMessageId,
            linkedUserMessageId: result?.linkedUserMessageId ?? userMessageId,
            interruptionText: result?.interruptionText ?? null,
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_INTERRUPTED',
            status: 'INTERRUPTED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              assistantMessageId: result?.assistantMessageId ?? acceptedAssistantMessageId,
              linkedUserMessageId: result?.linkedUserMessageId ?? userMessageId,
              interruptionText: result?.interruptionText ?? null,
              url: result?.url ?? this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        const missionBeforeCapture = this.state.missions[envelope.envelopeId];
        const acceptedBeforeCapture = missionBeforeCapture?.acceptedAssistantMessageId ?? null;
        const resultAssistantMessageId = result?.assistantMessageId ?? null;
        const placeholderMigrationAllowed = Boolean(
          acceptedBeforeCapture
          && acceptedBeforeCapture.startsWith('request-placeholder-')
          && resultAssistantMessageId
          && resultAssistantMessageId !== acceptedBeforeCapture
          && result?.assistantIdMigratedFrom === acceptedBeforeCapture
          && result?.linkedUserMessageId === userMessageId
          && missionBeforeCapture?.delivery?.userMessageId === userMessageId
        );

        if (placeholderMigrationAllowed) {
          this.#storeMission({
            ...missionBeforeCapture,
            acceptedAssistantStartMessageId:
              missionBeforeCapture.acceptedAssistantStartMessageId ?? acceptedBeforeCapture,
            acceptedAssistantMessageId: resultAssistantMessageId,
            assistantMessageIdMigratedFrom: acceptedBeforeCapture,
          });
        }

        let capture;
        try {
          capture = createResultCapture({
            record: this.state.missions[envelope.envelopeId],
            result,
            marker,
            capturedAt: this.now(),
          });
        } catch (error) {
          this.#storeMission({
            ...this.state.missions[envelope.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: error.message,
          });
          this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
            error: error.message,
            terminalSignal: result?.terminalSignal ?? null,
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_RESULT_UNVERIFIED',
            status: 'UNVERIFIED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              error: error.message,
              terminalSignal: result?.terminalSignal ?? null,
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        const currentBeforeResultStore = this.state.missions[envelope.envelopeId];
        const withResult = {
          ...currentBeforeResultStore,
          acceptedAssistantStartMessageId: capture.acceptedAssistantStartMessageId,
          acceptedAssistantMessageId: capture.acceptedAssistantMessageId,
          reconciliationRequired: false,
          reconciliationReason: null,
          reconciliationOutcome: currentBeforeResultStore?.cancellationRequested
            ? 'result_completed_after_cancel_request'
            : currentBeforeResultStore?.reconciliationOutcome ?? null,
          reconciledAt: currentBeforeResultStore?.cancellationRequested
            ? this.now()
            : currentBeforeResultStore?.reconciledAt ?? null,
          cancellationOutcome: currentBeforeResultStore?.cancellationRequested
            ? 'too_late_result_completed'
            : currentBeforeResultStore?.cancellationOutcome ?? null,
          result: capture,
        };
        this.#storeMission(transitionMissionState(withResult, 'RESULT_CAPTURED', {
          at: this.now(),
          evidence: {
            assistantMessageId: capture.assistantMessageId,
            conversationId: capture.conversationId,
            resultSha256: capture.resultSha256,
            terminalSignal: capture.terminalProof.terminalSignal,
          },
        }));
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_CAPTURED',
          status: 'RESULT_CAPTURED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            executionId,
            assistantMessageId: capture.assistantMessageId,
            conversationId: capture.conversationId,
            resultSha256: capture.resultSha256,
            terminalSignal: capture.terminalProof.terminalSignal,
            url: capture.url ?? this.surface.getUrl(pane) ?? null,
          },
          now: this.now(),
        }));

        const reloaded = this.loadState();
        const persistedCapture = reloaded?.missions?.[envelope.envelopeId]?.result ?? null;
        const readBackValid = verifyResultCapture(persistedCapture)
          && persistedCapture?.resultSha256 === capture.resultSha256
          && persistedCapture?.assistantMessageId === capture.assistantMessageId
          && persistedCapture?.conversationId === capture.conversationId
          && persistedCapture?.executionId === executionId
          && persistedCapture?.envelopeId === envelope.envelopeId;

        if (!readBackValid) {
          this.#transitionMission(envelope.envelopeId, 'UNVERIFIED', {
            error: 'result_readback_integrity_failed',
          });
          return this.#record(createAgentReceipt({
            kind: 'MISSION_RESULT_UNVERIFIED',
            status: 'UNVERIFIED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              executionId,
              error: 'result_readback_integrity_failed',
              resultSha256: capture.resultSha256,
            },
            now: this.now(),
          }));
        }

        const beforeCompletion = this.state.missions[envelope.envelopeId];
        this.#storeMission({
          ...beforeCompletion,
          reconciliationRequired: false,
          reconciliationReason: null,
          reconciliationOutcome: beforeCompletion?.cancellationRequested
            ? 'result_completed_after_cancel_request'
            : beforeCompletion?.reconciliationOutcome ?? 'result_validated',
          reconciledAt: beforeCompletion?.reconciliationRequired || beforeCompletion?.cancellationRequested
            ? this.now()
            : beforeCompletion?.reconciledAt ?? null,
          cancellationOutcome: beforeCompletion?.cancellationRequested
            ? 'too_late_result_completed'
            : beforeCompletion?.cancellationOutcome ?? null,
        });
        this.#transitionMission(envelope.envelopeId, 'COMPLETED', {
          assistantMessageId: capture.assistantMessageId,
          conversationId: capture.conversationId,
          resultSha256: capture.resultSha256,
          cancellationOutcome: beforeCompletion?.cancellationRequested
            ? 'too_late_result_completed'
            : null,
        });
        return this.#record(createAgentReceipt({
          kind: 'MISSION_COMPLETED',
          status: 'COMPLETED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            executionId,
            assistantMessageId: capture.assistantMessageId,
            conversationId: capture.conversationId,
            resultSha256: capture.resultSha256,
            terminalSignal: capture.terminalProof.terminalSignal,
            url: capture.url ?? this.surface.getUrl(pane) ?? null,
          },
          now: this.now(),
        }));
      });

    this.paneMissionQueues.set(pane, missionTask);
    this.missionTasks.set(envelope.envelopeId, missionTask);
    void missionTask.finally(() => {
      if (this.paneMissionQueues.get(pane) === missionTask) {
        this.paneMissionQueues.delete(pane);
      }
      this.missionTasks.delete(envelope.envelopeId);
    });

    return {
      ok: true,
      retried: Boolean(retryContext),
      retryOfEnvelopeId: retryContext?.retryOfEnvelopeId ?? null,
      attemptNumber: retryContext?.attemptNumber ?? 1,
      queued: true,
      delivered: null,
      accepted: null,
      deliveryPending: true,
      acceptancePending: true,
      acceptanceMarker: marker,
      envelope,
      receipt: queuedReceipt,
      acceptanceReceipt: null,
    };
  }

  async recoverPersistedMissions() {
    const results = [];

    for (const record of Object.values(this.state.missions ?? {})) {
      if (!record?.envelopeId) continue;

      if (record.state === 'RESULT_CAPTURED') {
        const context = this.#missionContext(record);
        const persisted = this.loadState()?.missions?.[record.envelopeId]?.result ?? record.result;
        if (!verifyResultCapture(persisted)) {
          this.#storeMission({
            ...this.state.missions[record.envelopeId],
            reconciliationRequired: true,
            reconciliationReason: 'restart_result_integrity_failed',
          });
          this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
            error: 'restart_result_integrity_failed',
          });
          this.#record(createAgentReceipt({
            kind: 'MISSION_RESULT_UNVERIFIED',
            status: 'UNVERIFIED',
            binding: context.binding,
            session: context.session,
            envelope: context.envelope,
            evidence: {
              pane: record.pane,
              executionId: record.executionId,
              error: 'restart_result_integrity_failed',
            },
            now: this.now(),
          }));
          results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
          continue;
        }

        const beforeRecoveredCompletion = this.state.missions[record.envelopeId];
        this.#storeMission({
          ...beforeRecoveredCompletion,
          reconciliationRequired: false,
          reconciliationReason: null,
          recoveryResumeRequired: false,
          cancellationOutcome: beforeRecoveredCompletion?.cancellationRequested
            ? 'too_late_result_completed'
            : beforeRecoveredCompletion?.cancellationOutcome ?? null,
        });
        this.#transitionMission(record.envelopeId, 'COMPLETED', {
          recoveredAfterRestart: true,
          assistantMessageId: persisted.assistantMessageId,
          resultSha256: persisted.resultSha256,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_COMPLETED',
          status: 'COMPLETED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            recoveredAfterRestart: true,
            assistantMessageId: persisted.assistantMessageId,
            conversationId: persisted.conversationId,
            resultSha256: persisted.resultSha256,
            terminalSignal: persisted.terminalProof?.terminalSignal ?? null,
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: true, state: 'COMPLETED' });
        continue;
      }

      const restartRecoverable = record.state === 'INTERRUPTED'
        || (
          record.state === 'UNVERIFIED'
          && record.reconciliationRequired === true
          && (
            record.recoveryResumeRequired === true
            || record.reconciliationReason === 'restart_during_recovery'
            || record.reconciliationReason === 'runtime_restart_execution_uncertain'
          )
        );
      if (!restartRecoverable) continue;

      let context;
      try {
        context = this.#missionContext(record);
      } catch (error) {
        this.#transitionMission(record.envelopeId, 'FAILED', { error: error.message });
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'FAILED', error: error.message });
        continue;
      }

      this.#record(createAgentReceipt({
        kind: 'MISSION_INTERRUPTED',
        status: 'INTERRUPTED',
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        evidence: {
          pane: record.pane,
          executionId: record.executionId,
          reason: 'runtime_restart',
        },
        now: this.now(),
      }));

      this.#transitionMission(record.envelopeId, 'RECOVERING', {
        reason: 'runtime_restart',
      });
      this.#record(createAgentReceipt({
        kind: 'MISSION_RECOVERING',
        status: 'RECOVERING',
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        evidence: {
          pane: record.pane,
          executionId: record.executionId,
          marker: context.marker,
        },
        now: this.now(),
      }));

      if (!context.userMessageId && !context.assistantMessageId) {
        const recoveredAnchor = await this.#recoverDeliveryAnchor(
          this.state.missions[record.envelopeId],
        );
        if (recoveredAnchor) context = this.#missionContext(recoveredAnchor);
      }

      const interruptedFrom = record?.lastTransition?.evidence?.previousState ?? null;
      const legacyRecoverableWithoutAnchor = ['DELIVERED', 'ACCEPTED', 'WORKING']
        .includes(interruptedFrom);
      if (!context.userMessageId && !context.assistantMessageId
          && !legacyRecoverableWithoutAnchor) {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'recovery_delivery_anchor_missing',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'recovery_delivery_anchor_missing',
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'recovery_delivery_anchor_missing',
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      if (typeof this.surface.waitForAssistantResult !== 'function') {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'result_recovery_surface_unavailable',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'result_recovery_surface_unavailable',
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'result_recovery_surface_unavailable',
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      const result = await this.surface.waitForAssistantResult(record.pane, {
        marker: context.marker,
        assistantMessageId: context.assistantMessageId,
        userMessageId: context.userMessageId,
        expectedConversationUrl: this.state.missions[record.envelopeId]?.delivery?.url ?? null,
        envelope: context.envelope,
        executionId: record.executionId,
        session: context.session,
        recovery: true,
      }, 30000);


      if (result?.terminalSignal === 'conversation_changed') {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'result_recovery_conversation_changed',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'result_recovery_conversation_changed',
          expectedConversationId: result.expectedConversationId ?? null,
          currentConversationId: result.currentConversationId ?? null,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'result_recovery_conversation_changed',
            expectedConversationId: result.expectedConversationId ?? null,
            currentConversationId: result.currentConversationId ?? null,
            url: result.url ?? this.surface.getUrl(record.pane) ?? null,
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      if (result?.terminalSignal === 'result_timeout') {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'result_recovery_timeout',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'result_recovery_timeout',
          terminalSignal: 'result_timeout',
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'result_recovery_timeout',
            terminalSignal: 'result_timeout',
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      if (result?.interrupted || result?.terminalSignal === 'assistant_interrupted') {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'assistant_interrupted_during_recovery',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'assistant_interrupted_during_recovery',
          terminalSignal: result?.terminalSignal ?? 'assistant_interrupted',
          interruptionText: result?.interruptionText ?? null,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'assistant_interrupted_during_recovery',
            terminalSignal: result?.terminalSignal ?? 'assistant_interrupted',
            interruptionText: result?.interruptionText ?? null,
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      let capture;
      try {
        capture = createResultCapture({
          record: this.state.missions[record.envelopeId],
          result,
          marker: context.marker,
          capturedAt: this.now(),
        });
      } catch (error) {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: error.message,
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: error.message,
          terminalSignal: result?.terminalSignal ?? null,
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: error.message,
            terminalSignal: result?.terminalSignal ?? null,
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      const withResult = {
        ...this.state.missions[record.envelopeId],
        acceptedAssistantStartMessageId: capture.acceptedAssistantStartMessageId,
        acceptedAssistantMessageId: capture.acceptedAssistantMessageId,
        assistantMessageIdMigratedFrom: capture.assistantIdMigratedFrom ?? null,
        reconciliationRequired: false,
        reconciliationReason: null,
        recoveryResumeRequired: false,
        reconciliationOutcome: 'restart_late_result_validated',
        reconciledAt: this.now(),
        result: capture,
      };
      this.#storeMission(transitionMissionState(withResult, 'RESULT_CAPTURED', {
        at: this.now(),
        evidence: {
          recoveredAfterRestart: true,
          assistantMessageId: capture.assistantMessageId,
          conversationId: capture.conversationId,
          resultSha256: capture.resultSha256,
        },
      }));
      this.#record(createAgentReceipt({
        kind: 'MISSION_RESULT_CAPTURED',
        status: 'RESULT_CAPTURED',
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        evidence: {
          pane: record.pane,
          executionId: record.executionId,
          recoveredAfterRestart: true,
          assistantMessageId: capture.assistantMessageId,
          conversationId: capture.conversationId,
          resultSha256: capture.resultSha256,
          terminalSignal: capture.terminalProof.terminalSignal,
        },
        now: this.now(),
      }));

      const persisted = this.loadState()?.missions?.[record.envelopeId]?.result ?? null;
      const valid = verifyResultCapture(persisted)
        && persisted?.resultSha256 === capture.resultSha256
        && persisted?.executionId === record.executionId
        && persisted?.envelopeId === record.envelopeId;

      if (!valid) {
        this.#storeMission({
          ...this.state.missions[record.envelopeId],
          reconciliationRequired: true,
          reconciliationReason: 'restart_result_readback_integrity_failed',
          recoveryResumeRequired: false,
        });
        this.#transitionMission(record.envelopeId, 'UNVERIFIED', {
          error: 'restart_result_readback_integrity_failed',
        });
        this.#record(createAgentReceipt({
          kind: 'MISSION_RESULT_UNVERIFIED',
          status: 'UNVERIFIED',
          binding: context.binding,
          session: context.session,
          envelope: context.envelope,
          evidence: {
            pane: record.pane,
            executionId: record.executionId,
            error: 'restart_result_readback_integrity_failed',
            resultSha256: capture.resultSha256,
          },
          now: this.now(),
        }));
        results.push({ envelopeId: record.envelopeId, ok: false, state: 'UNVERIFIED' });
        continue;
      }

      this.#transitionMission(record.envelopeId, 'COMPLETED', {
        recoveredAfterRestart: true,
        assistantMessageId: capture.assistantMessageId,
        resultSha256: capture.resultSha256,
      });
      this.#record(createAgentReceipt({
        kind: 'MISSION_COMPLETED',
        status: 'COMPLETED',
        binding: context.binding,
        session: context.session,
        envelope: context.envelope,
        evidence: {
          pane: record.pane,
          executionId: record.executionId,
          recoveredAfterRestart: true,
          assistantMessageId: capture.assistantMessageId,
          conversationId: capture.conversationId,
          resultSha256: capture.resultSha256,
          terminalSignal: capture.terminalProof.terminalSignal,
        },
        now: this.now(),
      }));
      results.push({ envelopeId: record.envelopeId, ok: true, state: 'COMPLETED' });
    }

    return {
      ok: results.every(item => item.ok),
      recovered: results,
    };
  }

  async waitForPendingMissions() {
    await Promise.allSettled([...this.missionTasks.values()]);
    return this.listReceipts();
  }

  async waitForPendingAcceptances() {
    return this.waitForPendingMissions();
  }
}
