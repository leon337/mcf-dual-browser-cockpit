import {
  agentBindingForPane,
  paneForAgent,
  validateCanonicalAgent,
  buildIdentityBootstrap,
  createMissionEnvelope,
  formatMissionEnvelope,
  createAgentReceipt,
} from './agent-identity.mjs';

export const PANE_AGENT_RUNTIME_SCHEMA = 'mcf-pane-agent-runtime/v1';

const PANES = Object.freeze(['chat', 'workspace']);
const RECEIPT_LIMIT = 500;

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function initialState(instanceId, missionId) {
  return {
    schema: PANE_AGENT_RUNTIME_SCHEMA,
    version: 1,
    instanceId,
    missionId,
    bindings: {},
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
    loadState = () => null,
    saveState = () => {},
    now = () => new Date().toISOString(),
  }) {
    if (!instanceId || !missionId || !broker || !surface) {
      throw new Error('invalid_agent_runtime_configuration');
    }
    this.instanceId = instanceId;
    this.missionId = missionId;
    this.broker = broker;
    this.surface = surface;
    this.loadState = loadState;
    this.saveState = saveState;
    this.now = now;
    this.missionTasks = new Map();
    this.paneMissionQueues = new Map();
    const loaded = loadState();
    this.state = loaded?.schema === PANE_AGENT_RUNTIME_SCHEMA
      ? {
          ...initialState(instanceId, missionId),
          ...loaded,
          instanceId,
          missionId,
          bindings: loaded.bindings ?? {},
          receipts: Array.isArray(loaded.receipts) ? loaded.receipts.slice(-RECEIPT_LIMIT) : [],
        }
      : initialState(instanceId, missionId);
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

  getIdentities() {
    return PANES.map((pane) => {
      const manifest = agentBindingForPane(pane);
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
    const manifest = agentBindingForPane(pane);
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

    const panes = agentId ? [paneForAgent(agentId)] : [...PANES];
    const results = [];
    for (const pane of panes) {
      try {
        results.push(await this.#bootstrapPane(pane, canonicalAgents, Boolean(force)));
      } catch (error) {
        const manifest = agentBindingForPane(pane);
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
    const pane = paneForAgent(input?.agentId);
    const manifest = agentBindingForPane(pane);
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
    const queuedReceipt = this.#record(createAgentReceipt({
      kind: 'MISSION_QUEUED',
      status: 'QUEUED',
      binding,
      session,
      envelope,
      evidence: {
        pane,
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
          return this.#record(createAgentReceipt({
            kind: 'MISSION_DELIVERY_FAILED',
            status: 'FAILED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              error: delivery?.error ?? 'mission_delivery_failed',
              url: this.surface.getUrl(pane) ?? null,
            },
            now: this.now(),
          }));
        }

        this.#record(createAgentReceipt({
          kind: 'MISSION_DELIVERED',
          status: 'DELIVERED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            url: delivery.url ?? this.surface.getUrl(pane) ?? null,
            method: delivery.method ?? null,
          },
          now: this.now(),
        }));

        const accepted = await this.surface.waitForAssistantMarker(pane, marker);
        if (accepted) {
          return this.#record(createAgentReceipt({
            kind: 'MISSION_ACCEPTED',
            status: 'ACCEPTED',
            binding,
            session,
            envelope,
            evidence: {
              pane,
              url: this.surface.getUrl(pane) ?? null,
              marker,
            },
            now: this.now(),
          }));
        }

        return this.#record(createAgentReceipt({
          kind: 'MISSION_ACCEPTANCE_UNVERIFIED',
          status: 'UNVERIFIED',
          binding,
          session,
          envelope,
          evidence: {
            pane,
            url: this.surface.getUrl(pane) ?? null,
            marker,
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

  async waitForPendingMissions() {
    await Promise.allSettled([...this.missionTasks.values()]);
    return this.listReceipts();
  }

  async waitForPendingAcceptances() {
    return this.waitForPendingMissions();
  }
}
