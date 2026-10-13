import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

test('control-center observability exposes operational summaries without mission bodies or URL secrets', async () => {
  const fakeWebContents = {
    getURL: () => 'https://user:password@example.test/task?access_token=do-not-expose#private',
    getTitle: () => 'Test page',
    isLoading: () => false,
    isDestroyed: () => false,
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => fakeWebContents,
    getPaneWebContents: () => fakeWebContents,
    captureDir: '/tmp/mcf-test-captures',
    instanceId: 'test-instance',
    agentProfile: 'debug-engineering',
    getAgentIdentities: async () => [{
      agentId: 'Rafael',
      role: 'Engenharia de Software',
      pane: 'workspace',
      state: 'READY',
      handshakeVerified: true,
      sessionId: 'session-123456',
      contractDigest: 'do-not-expose-contract-digest',
    }],
    listAgentMissions: async () => [{
      missionId: 'TEST-MISSION',
      envelopeId: 'envelope-123',
      agentId: 'Rafael',
      pane: 'workspace',
      state: 'WORKING',
      objective: 'do-not-expose-private-objective',
      result: { text: 'do-not-expose-private-result' },
      createdAt: '2026-10-12T12:00:00.000Z',
    }],
    listAgentReceipts: async () => [{
      receiptId: 'receipt-123',
      kind: 'MISSION_QUEUED',
      status: 'QUEUED',
      createdAt: '2026-10-12T12:00:00.000Z',
      agent: { agentId: 'Rafael' },
      envelope: { envelopeId: 'envelope-123' },
      evidence: { token: 'do-not-expose-receipt-token' },
    }],
  });

  bridge.publishLiveEvent({
    type: 'MISSION_WORKING',
    source: 'test',
    authority: 'observational',
    missionId: 'TEST-MISSION',
    objective: 'do-not-expose-private-objective',
    result: { text: 'do-not-expose-private-result' },
  });

  const snapshot = await bridge.getObservabilitySnapshot({ eventLimit: 25 });
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.schema, 'mcf-cockpit-observability/v1');
  assert.equal(snapshot.bridge.instanceId, 'test-instance');
  assert.equal(snapshot.agents[0].handshakeVerified, true);
  assert.equal(snapshot.missions[0].state, 'WORKING');
  assert.equal(snapshot.events[0].type, 'MISSION_WORKING');
  assert.equal(snapshot.panes[0].url, 'https://example.test/task');
  assert.equal('token' in snapshot.bridge, false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('access_token'), false);
  assert.equal(serialized.includes('private-objective'), false);
  assert.equal(serialized.includes('private-result'), false);
  assert.equal(serialized.includes('contract-digest'), false);
  assert.equal(serialized.includes('receipt-token'), false);
});
