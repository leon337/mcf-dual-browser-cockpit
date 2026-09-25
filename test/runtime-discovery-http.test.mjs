import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

test('GET /v1/discovery exposes mechanisms and current runtime inventory', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-discovery-'));
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.com/',
    getTitle: () => 'fixture',
    isLoading: () => false,
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
  };

  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dir,
    instanceId: 'notebook-team2',
    agentProfile: 'debug-engineering',
    getAgentIdentities: async () => [{ agentId: 'Rafael', pane: 'workspace' }],
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
  assert.equal(body.discovery.current.agentSessions[0].deliveryVerified, false);
  assert.equal(
    body.discovery.current.agentSessions[0].stateWarning,
    'open_without_conversation_evidence',
  );
});
