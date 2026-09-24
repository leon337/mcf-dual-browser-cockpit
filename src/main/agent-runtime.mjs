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
        this.state.missions[envelopeId] = transitionMissionState(record, 'INTERRUPTED', {
          at: this.now(),
          evidence: {
            reason: 'runtime_restart',
            previousState: record.state,
          },
        });
        changed = true;
      } else if (record?.state === 'RECOVERING') {
        this.state.missions[envelopeId] = transitionMissionState(record, 'UNVERIFIED', {
          at: this.now(),
          evidence: {
            reason: 'restart_during_recovery',
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

  #record(receipt) {
    this.state.receipts.push(receipt);
    this.#persist();
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

  getParentMissionStatus(parentMissionId) {
    return parentMissionStatus(parentMissionId, this.listMissions());
  }

  #storeMission(record) {
    this.state.missions[record.envelopeId] = record;
    this.#persist();
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
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.surface.freshConversation(pane);
      } catch (error) {
        lastError = error;
        const message = String(error?.message || error || '');
        const transient = message.includes('ERR_ABORTED') || message.includes('(-3)');
        if (!transient || attempt === 3) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 150));
      }
    }
    throw lastError ?? new Error('fresh_conversation_failed');
  }

  async #bootstrapPane(pane, canonicalAgents, force) {
    const manifest = agentBindingForPane(pane, this.agentBindings);
    const canonical = canonicalAgents.find(agent => agent.agentId === manifest.agentId);
    const binding = validateCanonicalAgent(manifest, canonical);
    const { session, reused } = await this.#sessionForPane(pane, binding, force);
    const current = this.state.bindings[pane];

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
      chatUrl: null,
      lastError: null,
      updatedAt: this.now(),
    };
    this.#persist();

    if (!reused || force || current?.state !== 'READY') {
      await this.#freshConversationWithRetry(pane);
    }

    const bootstrap = buildIdentityBootstrap({ binding, session });
    const delivery = await this.surface.sendMessage(pane, bootstrap);
    if (!delivery?.ok) {
      const failed = this.state.bindings[pane];
      failed.state = 'ERROR';
      failed.lastError = delivery?.error ?? 'identity_bootstrap_delivery_failed';
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
      },
      now: this.now(),
    }));

    const marker = 'MCF_AGENT_READY agent_id=' + binding.agentId + ' session_id=' + session.sessionId;
    const verified = await this.surface.waitForAssistantMarker(pane, marker);

    const record = this.state.bindings[pane];
    record.chatUrl = delivery.url ?? this.surface.getUrl(pane) ?? null;
    record.handshakeVerified = Boolean(verified);
    record.state = verified ? 'READY' : 'UNVERIFIED';
    record.lastError = verified ? null : 'identity_handshake_not_observed';
    record.updatedAt = this.now();
    this.#persist();

    if (!verified) {
      this.#record(createAgentReceipt({
        kind: 'HANDSHAKE_UNVERIFIED',
        status: 'UNVERIFIED',
        binding,
        session,
        evidence: { pane, url: record.chatUrl },
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
      evidence: { pane, url: record.chatUrl, marker },
      now: this.now(),
    }));
    return { ok: true, reused, identity: clone(record), receipt };
  }

  async bootstrap({ agentId = null, force = false } = {}) {
    const registry = await this.broker.listAgents();
    const canonicalAgents = Array.isArray(registry) ? registry : registry?.agents;
    if (!Array.isArray(canonicalAgents)) throw new Error('canonical_agent_registry_unavailable');

    const panes = agentId ? [paneForAgent(agentId, this.agentBindings)] : [...PANES];
    const results = [];
    for (const pane of panes) {
      try {
        results.push(await this.#bootstrapPane(pane, canonicalAgents, Boolean(force)));
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
        results.push({ ok: false, error: error.message, identity: clone(current) });
      }
    }

    return {
      ok: results.every(result => result.ok),
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
        const delivery = await this.surface.sendMessage(pane, formatMissionEnvelope(envelope));
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
          while (true) {
            acceptance = await this.surface.waitForAssistantStart(pane, {
              marker,
              envelope,
              executionId,
              session,
              userMessageId,
              baselineAssistantMessageId,
            });

            const stillWaitingForAssistantIdentity = !acceptance?.accepted
              && !acceptance?.interrupted
              && acceptance?.error === 'assistant_start_timeout'
              && acceptance?.generationActive === true;

            if (!stillWaitingForAssistantIdentity) break;

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
                observation: 'assistant_start_timeout_generation_active_non_terminal',
                generationActive: true,
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

        if (!acceptance?.accepted) {
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
        while (true) {
          result = await this.surface.waitForAssistantResult(pane, {
            marker,
            assistantMessageId: acceptedAssistantMessageId,
            userMessageId,
            baselineAssistantMessageId,
            envelope,
            executionId,
            session,
          });

          if (result?.terminalSignal !== 'result_timeout') break;

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
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        if (result?.interrupted || result?.terminalSignal === 'assistant_interrupted') {
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

        const withResult = {
          ...this.state.missions[envelope.envelopeId],
          acceptedAssistantStartMessageId: capture.acceptedAssistantStartMessageId,
          acceptedAssistantMessageId: capture.acceptedAssistantMessageId,
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

        this.#transitionMission(envelope.envelopeId, 'COMPLETED', {
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

      if (record.state !== 'INTERRUPTED') continue;

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

      const interruptedFrom = record?.lastTransition?.evidence?.previousState ?? null;
      const legacyRecoverableWithoutAnchor = ['DELIVERED', 'ACCEPTED', 'WORKING']
        .includes(interruptedFrom);
      if (!context.userMessageId && !context.assistantMessageId
          && !legacyRecoverableWithoutAnchor) {
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
        envelope: context.envelope,
        executionId: record.executionId,
        session: context.session,
        recovery: true,
      }, 30000);


      if (result?.terminalSignal === 'result_timeout') {
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
