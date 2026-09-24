import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const AGENT_IDENTITY_SCHEMA = 'mcf-agent-identity/v1';
export const MISSION_ENVELOPE_SCHEMA = 'mcf-mission-envelope/v1';
export const AGENT_RECEIPT_SCHEMA = 'mcf-agent-receipt/v1';

function loadManifest(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, 'utf8'));
  if (parsed?.schema !== 'mcf-agent-identity-manifest/v1') {
    throw new Error('invalid_agent_identity_manifest');
  }
  return Object.freeze(parsed);
}

const EMILY = loadManifest('../../agents/emily.json');
const SOFIA = loadManifest('../../agents/sofia.json');

const BINDINGS = Object.freeze({
  chat: EMILY,
  workspace: SOFIA,
});

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function stableSha256(value) {
  const encoded = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(encoded).digest('hex');
}

export function agentBindingForPane(pane) {
  const binding = BINDINGS[pane];
  if (!binding) throw new Error('unknown_agent_pane');
  return binding;
}

export function paneForAgent(agent) {
  const needle = String(agent || '').trim().toLowerCase();
  if (['emily', 'emilly'].includes(needle)) return 'chat';
  if (['sofia', 'sophia'].includes(needle)) return 'workspace';
  throw new Error('unknown_canonical_agent');
}

export function validateCanonicalAgent(binding, canonical) {
  const digest = String(canonical?.contractDigest || '');
  const valid = canonical
    && canonical.agentId === binding.agentId
    && canonical.role === binding.role
    && canonical.contractRef === binding.contractRef
    && /^[a-f0-9]{64}$/.test(digest);
  if (!valid) throw new Error('canonical_agent_mismatch');
  return Object.freeze({
    ...binding,
    contractDigest: digest,
  });
}

export function buildIdentityBootstrap({ binding, session }) {
  if (!binding?.agentId || !session?.sessionId || !session?.traceId || !session?.bootstrap) {
    throw new Error('invalid_identity_bootstrap_input');
  }
  if (session.agentId !== binding.agentId
      || session.role !== binding.role
      || session.contractRef !== binding.contractRef
      || !/^[a-f0-9]{64}$/.test(String(session.contractDigest || ''))) {
    throw new Error('identity_session_mismatch');
  }
  return [
    '[MCF PANE AGENT IDENTITY]',
    'schema: ' + AGENT_IDENTITY_SCHEMA,
    'pane: ' + binding.pane,
    'agent_id: ' + binding.agentId,
    'role: ' + binding.role,
    'session_id: ' + session.sessionId,
    'trace_id: ' + session.traceId,
    'contract_ref: ' + binding.contractRef,
    'contract_sha256: ' + session.contractDigest,
    '',
    'This pane is identity-bound to the canonical MCF agent above.',
    'LEANDRO remains final human authority. MESTRE remains the orchestrator.',
    'Do not expand authority, capabilities, or evidence beyond the canonical contract.',
    '',
    session.bootstrap.trim(),
    '',
    '[MCF HANDSHAKE REQUIRED]',
    'Reply with this exact marker on one line:',
    'MCF_AGENT_READY agent_id=' + binding.agentId + ' session_id=' + session.sessionId,
  ].join('\n');
}

export function detectReadyHandshake(text, { binding, session }) {
  const haystack = String(text || '');
  const marker = 'MCF_AGENT_READY agent_id=' + binding.agentId + ' session_id=' + session.sessionId;
  return haystack.includes(marker);
}

function normalizeStringArray(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('mission_array_required');
  return value.map(item => String(item).trim()).filter(Boolean);
}

export function createMissionEnvelope({
  binding,
  session,
  input,
  envelopeId = randomUUID(),
  now = new Date().toISOString(),
}) {
  if (!binding?.agentId || !session?.sessionId || !session?.traceId) {
    throw new Error('invalid_mission_identity');
  }
  if (!input?.missionId || !String(input?.objective || '').trim()) {
    throw new Error('invalid_mission_envelope');
  }
  if (input.agentId && input.agentId !== binding.agentId) {
    throw new Error('mission_agent_mismatch');
  }
  return Object.freeze({
    schema: MISSION_ENVELOPE_SCHEMA,
    envelopeId,
    createdAt: now,
    missionId: String(input.missionId),
    agent: {
      agentId: binding.agentId,
      role: binding.role,
      pane: binding.pane,
      contractRef: binding.contractRef,
      contractDigest: session.contractDigest ?? null,
    },
    session: {
      sessionId: session.sessionId,
      traceId: session.traceId,
    },
    authority: {
      human: 'LEANDRO',
      orchestrator: 'MESTRE',
    },
    objective: String(input.objective).trim(),
    inputs: normalizeStringArray(input.inputs),
    constraints: normalizeStringArray(input.constraints),
    expectedOutputs: normalizeStringArray(input.expectedOutputs),
  });
}

export function formatMissionEnvelope(envelope) {
  return [
    '[MCF MISSION ENVELOPE]',
    JSON.stringify(envelope, null, 2),
    '',
    'Acknowledge receipt with:',
    'MCF_MISSION_ACCEPTED envelope_id=' + envelope.envelopeId + ' agent_id=' + envelope.agent.agentId,
  ].join('\n');
}

export function createAgentReceipt({
  kind,
  status,
  binding,
  session,
  envelope = null,
  evidence = null,
  receiptId = randomUUID(),
  now = new Date().toISOString(),
}) {
  if (!kind || !status || !binding?.agentId || !session?.sessionId) {
    throw new Error('invalid_agent_receipt');
  }
  return Object.freeze({
    schema: AGENT_RECEIPT_SCHEMA,
    identitySchema: AGENT_IDENTITY_SCHEMA,
    receiptId,
    kind,
    status,
    createdAt: now,
    agent: {
      agentId: binding.agentId,
      role: binding.role,
      pane: binding.pane,
      contractRef: binding.contractRef,
      contractDigest: session.contractDigest ?? null,
    },
    session: {
      sessionId: session.sessionId,
      traceId: session.traceId ?? null,
    },
    envelope: envelope ? {
      envelopeId: envelope.envelopeId,
      missionId: envelope.missionId,
      sha256: stableSha256(envelope),
    } : null,
    evidence: evidence ?? null,
  });
}
