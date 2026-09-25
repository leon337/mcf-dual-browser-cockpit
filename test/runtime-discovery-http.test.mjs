import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

test('GET /v1/discovery exposes mechanisms, pane conversations and runtime inventory', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-discovery-'));

  function wcFor(pane) {
    const url = pane === 'workspace'
      ? 'https://chatgpt.com/g/g-rafael/c/rafael-restored'
      : 'https://chatgpt.com/g/g-patricia/c/patricia-restored';
    return {
      isDestroyed: () => false,
      getURL: () => url,
      getTitle: () => pane,
      isLoading: () => false,
      navigationHistory: {
        canGoBack: () => false,
        canGoForward: () => false,
      },
    };
  }

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wcFor('workspace'),
    getPaneWebContents: pane => wcFor(pane),
    captureDir: dir,
    instanceId: 'notebook-team2',
    agentProfile: 'debug-engineering',
    getAgentIdentities: async () => [{
      agentId: 'Rafael',
      pane: 'workspace',
      state: 'ERROR',
      handshakeVerified: false,
      lastError: 'identity_bootstrap_reconciliation_required',
    }],
    listCanonicalAgents: async () => [{ agentId: 'Rafael' }, { agentId: 'Carmem' }],
    listAgentSessions: async () => [{
      sessionId: 'legacy',
      surfaceState: 'OPEN',
      bootstrapSent: true,
      chatUrl: 'https://chatgpt.com/',
    }],
  });
  await bridge.start(0);
  t.after(async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true });
  });

  const response = await fetch(`http://127.0.0.1:${bridge.port}/v1/discovery`, {
    headers: {
      Authorization: `Bearer ${bridge.token}`,
      'X-MCF-Instance': 'notebook-team2',
    },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.discovery.schema, 'mcf-dual-browser-runtime-discovery/v1');
  assert.equal(body.discovery.current.paneAgents[0].agentId, 'Rafael');
  assert.equal(body.discovery.current.canonicalAgents.length, 2);
  assert.equal(
    body.discovery.current.panes.find(item => item.pane === 'workspace').conversationId,
    'rafael-restored',
  );
  assert.equal(body.discovery.current.agentSessions[0].deliveryVerified, false);
  assert.equal(
    body.discovery.current.agentSessions[0].stateWarning,
    'open_without_conversation_evidence',
  );
  assert.ok(
    body.discovery.warnings.some(
      item => item.warning === 'identity_not_ready_conversation_preserved'
        && item.agentId === 'Rafael',
    ),
  );
});
