import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_IDENTITY_SCHEMA,
  agentBindingForPane,
  validateCanonicalAgent,
  buildIdentityBootstrap,
  detectReadyHandshake,
  createMissionEnvelope,
  formatMissionEnvelope,
  createAgentReceipt,
} from '../src/main/agent-identity.mjs';

const canonicalEmily = {
  agentId: 'Emily',
  role: 'Auditoria Independente',
  contractRef: 'docs/agentes/EMILY.md',
  contractDigest: '9385ac2330d966133814c899540e9f33daad0f5eb423ec6a0a3e4a0bb48d70f4',
};

const canonicalSofia = {
  agentId: 'Sofia',
  role: 'Arquitetura de Software',
  contractRef: 'docs/agentes/SOFIA.md',
  contractDigest: '06ffc53d7466471b1541070990b02acde1a7350a63cb41b1b299f3ef0f28b6f3',
};

test('pane bindings are canonical and role-specific', () => {
  const emily = agentBindingForPane('chat');
  const sofia = agentBindingForPane('workspace');

  assert.equal(emily.agentId, 'Emily');
  assert.equal(emily.role, 'Auditoria Independente');
  assert.equal(emily.contractRef, 'docs/agentes/EMILY.md');
  assert.equal(emily.pane, 'chat');

  assert.equal(sofia.agentId, 'Sofia');
  assert.equal(sofia.role, 'Arquitetura de Software');
  assert.equal(sofia.contractRef, 'docs/agentes/SOFIA.md');
  assert.equal(sofia.pane, 'workspace');

  assert.throws(() => agentBindingForPane('other'), /unknown_agent_pane/);
});

test('canonical identity validation fails closed on role or contract mismatch', () => {
  const emily = validateCanonicalAgent(agentBindingForPane('chat'), canonicalEmily);
  assert.equal(emily.contractDigest, canonicalEmily.contractDigest);

  assert.throws(
    () => validateCanonicalAgent(agentBindingForPane('chat'), { ...canonicalEmily, role: 'Arquitetura' }),
    /canonical_agent_mismatch/,
  );
  assert.throws(
    () => validateCanonicalAgent(agentBindingForPane('workspace'), canonicalEmily),
    /canonical_agent_mismatch/,
  );
});

test('identity bootstrap binds session, contract digest and strict ready marker', () => {
  const binding = agentBindingForPane('workspace');
  const session = {
    sessionId: 'sess-sofia-123',
    traceId: 'trace-sofia-123',
    missionId: 'MCF-DUAL-AGENT-IDENTITY-001',
    agentId: 'Sofia',
    role: 'Arquitetura de Software',
    contractRef: binding.contractRef,
    contractDigest: canonicalSofia.contractDigest,
    bootstrap: '[MCF AGENT SESSION]\ncontrato canônico aqui',
  };

  const bootstrap = buildIdentityBootstrap({ binding, session });
  assert.match(bootstrap, /MCF PANE AGENT IDENTITY/);
  assert.match(bootstrap, /agent_id: Sofia/);
  assert.match(bootstrap, /pane: workspace/);
  assert.match(bootstrap, /sess-sofia-123/);
  assert.match(bootstrap, /MCF_AGENT_READY/);

  assert.equal(
    detectReadyHandshake('MCF_AGENT_READY agent_id=Sofia session_id=sess-sofia-123', { binding, session }),
    true,
  );
  assert.equal(
    detectReadyHandshake('MCF_AGENT_READY agent_id=Emily session_id=sess-sofia-123', { binding, session }),
    false,
  );
});

test('mission envelope is bound to the canonical agent and rejects cross-agent routing', () => {
  const binding = agentBindingForPane('chat');
  const session = {
    sessionId: 'sess-emily-123',
    traceId: 'trace-emily-123',
    contractDigest: canonicalEmily.contractDigest,
  };
  const envelope = createMissionEnvelope({
    binding,
    session,
    input: {
      missionId: 'MISSION-123',
      agentId: 'Emily',
      objective: 'Auditar evidências do runtime de identidade.',
      inputs: ['artifact-A'],
      constraints: ['não corrigir o artefato auditado'],
      expectedOutputs: ['parecer'],
    },
    envelopeId: 'env-123',
    now: '2026-09-24T00:00:00.000Z',
  });

  assert.equal(envelope.schema, 'mcf-mission-envelope/v1');
  assert.equal(envelope.envelopeId, 'env-123');
  assert.equal(envelope.agent.agentId, 'Emily');
  assert.equal(envelope.agent.pane, 'chat');
  assert.equal(envelope.authority.human, 'LEANDRO');
  assert.equal(envelope.authority.orchestrator, 'MESTRE');

  assert.throws(() => createMissionEnvelope({
    binding,
    session,
    input: { missionId: 'MISSION-123', agentId: 'Sofia', objective: 'wrong target' },
  }), /mission_agent_mismatch/);
});

test('agent receipt cryptographically links identity, session and envelope without claiming completion', () => {
  const binding = agentBindingForPane('chat');
  const session = {
    sessionId: 'sess-emily-123',
    traceId: 'trace-emily-123',
    contractDigest: canonicalEmily.contractDigest,
  };
  const envelope = createMissionEnvelope({
    binding,
    session,
    input: {
      missionId: 'MISSION-123',
      agentId: 'Emily',
      objective: 'Auditar evidências.',
    },
    envelopeId: 'env-123',
    now: '2026-09-24T00:00:00.000Z',
  });
  const receipt = createAgentReceipt({
    kind: 'MISSION_DELIVERED',
    status: 'DELIVERED',
    binding,
    session,
    envelope,
    evidence: { url: 'https://chatgpt.com/c/example' },
    receiptId: 'receipt-123',
    now: '2026-09-24T00:00:01.000Z',
  });

  assert.equal(receipt.schema, 'mcf-agent-receipt/v1');
  assert.equal(receipt.identitySchema, AGENT_IDENTITY_SCHEMA);
  assert.equal(receipt.agent.agentId, 'Emily');
  assert.equal(receipt.session.sessionId, 'sess-emily-123');
  assert.equal(receipt.envelope.envelopeId, 'env-123');
  assert.match(receipt.envelope.sha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.status, 'DELIVERED');
  assert.notEqual(receipt.status, 'COMPLETED');
});


test('packaging includes canonical agent identity manifests', async () => {
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.build.files.includes('agents/**/*'));
  assert.doesNotThrow(() => agentBindingForPane('chat'));
  assert.doesNotThrow(() => agentBindingForPane('workspace'));
});


test('mission envelope requires the exact acceptance marker as the first assistant line', () => {
  const binding = agentBindingForPane('chat');
  const session = {
    sessionId: 'sess-emily-accept',
    traceId: 'trace-emily-accept',
    contractDigest: canonicalEmily.contractDigest,
  };
  const envelope = createMissionEnvelope({
    binding,
    session,
    input: {
      missionId: 'MISSION-ACCEPT',
      agentId: 'Emily',
      objective: 'Executar missão.',
    },
    envelopeId: 'env-accept',
    now: '2026-09-24T07:30:00.000Z',
  });
  const formatted = formatMissionEnvelope(envelope);
  assert.match(formatted, /FIRST ASSISTANT LINE MUST BE EXACTLY/);
  assert.match(
    formatted,
    /MCF_MISSION_ACCEPTED envelope_id=env-accept agent_id=Emily/,
  );
  assert.match(formatted, /Do not paraphrase, translate, prefix, suffix, or omit this marker/);
});
