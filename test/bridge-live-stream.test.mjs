import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

test('authenticated Agent Bridge streams live navigation events over SSE', async () => {
  const bridge = new LocalAgentBridge({
    instanceId: 'test-instance',
    agentProfile: 'test-profile',
    getWorkspaceWebContents: () => null,
    captureDir: '/tmp',
  });
  const state = await bridge.start(0);
  let reader;
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/v1/live/stream`, {
      headers: {
        authorization: `Bearer ${state.token}`,
        'x-mcf-instance': 'test-instance',
        accept: 'text/event-stream',
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type')?.startsWith('text/event-stream'), true);
    reader = response.body.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.match(new TextDecoder().decode(first.value), /channel\.ready/);

    bridge.publishLiveEvent({ type: 'NAVIGATION_FINISHED', pane: 'workspace', url: 'https://example.com/' });
    const second = await reader.read();
    assert.equal(second.done, false);
    assert.match(new TextDecoder().decode(second.value), /navigation_finished/);

    const denied = await fetch(`http://127.0.0.1:${state.port}/v1/live/snapshot`, {
      headers: { authorization: `Bearer ${state.token}`, 'x-mcf-instance': 'wrong-instance' },
    });
    assert.equal(denied.status, 409);
  } finally {
    await reader?.cancel().catch(() => {});
    await bridge.stop();
  }
});