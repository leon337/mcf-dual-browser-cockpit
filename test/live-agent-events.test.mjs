import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LiveAgentEventBus } from '../src/main/live-agent-events.mjs';
import { LocalAgentBridge } from '../src/main/bridge.mjs';

test('live event bus keeps bounded replay and reports a cursor gap', () => {
  let tick = 0;
  const bus = new LiveAgentEventBus({
    instanceId: 'notebook',
    bootId: 'boot-a',
    limit: 8,
    heartbeatMs: 1000,
    now: () => '2026-09-24T11:30:' + String(tick++).padStart(2, '0') + '.000Z',
  });

  for (let i = 1; i <= 10; i += 1) {
    bus.publish({ type: 'MISSION_STATE', mission: { envelopeId: 'e-' + i, state: 'WORKING' } });
  }

  const recent = bus.snapshot('boot-a:8');
  assert.equal(recent.resetRequired, false);
  assert.deepEqual(recent.events.map(event => event.eventId), ['boot-a:9', 'boot-a:10']);
  assert.ok(recent.events.every(event => event.instanceId === 'notebook'));

  const stale = bus.snapshot('boot-a:1');
  assert.equal(stale.resetRequired, true);
  assert.equal(stale.resetReason, 'cursor_expired');
  assert.equal(stale.oldestEventId, 'boot-a:3');
  assert.equal(stale.highWatermarkEventId, 'boot-a:10');
  assert.deepEqual(stale.events.map(event => event.eventId), [
    'boot-a:3', 'boot-a:4', 'boot-a:5', 'boot-a:6',
    'boot-a:7', 'boot-a:8', 'boot-a:9', 'boot-a:10',
  ]);

  const restarted = bus.snapshot('old-boot:99');
  assert.equal(restarted.resetRequired, true);
  assert.equal(restarted.resetReason, 'boot_changed');
});

test('bridge live event snapshot is authenticated and isolated to its instance', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-live-events-'));
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.test/',
    getTitle: () => 'chat',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dir,
    instanceId: 'notebook-test',
    getAgentIdentities: async () => [{ agentId: 'Emily', pane: 'chat', state: 'READY' }],
    listAgentMissions: async () => [{ envelopeId: 'env-1', state: 'WORKING' }],
  });
  await bridge.start(0);
  t.after(async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  bridge.publishLiveEvent({
    type: 'MISSION_STATE',
    mission: { envelopeId: 'env-1', agentId: 'Emily', state: 'WORKING' },
  });

  const base = 'http://127.0.0.1:' + bridge.port;
  const unauthorized = await fetch(base + '/v1/events/snapshot');
  assert.equal(unauthorized.status, 401);

  const headers = {
    Authorization: 'Bearer ' + bridge.token,
    'x-mcf-instance': 'notebook-test',
  };
  const missingInstance = await fetch(base + '/v1/live/snapshot', {
    headers: { Authorization: 'Bearer ' + bridge.token },
  });
  assert.equal(missingInstance.status, 400);

  const wrongInstance = await fetch(base + '/v1/live/snapshot', {
    headers: { Authorization: 'Bearer ' + bridge.token, 'x-mcf-instance': 'other' },
  });
  assert.equal(wrongInstance.status, 409);

  const response = await fetch(base + '/v1/live/snapshot', { headers });
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.instanceId, 'notebook-test');
  assert.equal(snapshot.agents[0].agentId, 'Emily');
  assert.equal(snapshot.missions[0].envelopeId, 'env-1');
  assert.ok(snapshot.events.some(event =>
    event.type === 'MISSION_STATE'
    && event.instanceId === 'notebook-test'
    && event.mission.envelopeId === 'env-1'
  ));
});


test('two bridges keep live journals and credentials isolated', async t => {
  const dirA = mkdtempSync(path.join(os.tmpdir(), 'mcf-live-a-'));
  const dirB = mkdtempSync(path.join(os.tmpdir(), 'mcf-live-b-'));
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.test/',
    getTitle: () => 'chat',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const a = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dirA,
    instanceId: 'notebook',
    agentProfile: 'audit-architecture',
  });
  const b = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dirB,
    instanceId: 'notebook-team2',
    agentProfile: 'debug-engineering',
  });
  await Promise.all([a.start(0), b.start(0)]);
  t.after(async () => {
    await Promise.all([a.stop(), b.stop()]);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  a.publishLiveEvent({ type: 'MISSION_STATE', mission: { envelopeId: 'env-a', agentId: 'Emily' } });
  b.publishLiveEvent({ type: 'MISSION_STATE', mission: { envelopeId: 'env-b', agentId: 'Patrícia' } });

  const snapA = await (await fetch('http://127.0.0.1:' + a.port + '/v1/live/snapshot', {
    headers: {
      Authorization: 'Bearer ' + a.token,
      'x-mcf-instance': 'notebook',
    },
  })).json();
  const snapB = await (await fetch('http://127.0.0.1:' + b.port + '/v1/live/snapshot', {
    headers: {
      Authorization: 'Bearer ' + b.token,
      'x-mcf-instance': 'notebook-team2',
    },
  })).json();

  assert.ok(snapA.events.some(event => event.mission?.envelopeId === 'env-a'));
  assert.ok(!snapA.events.some(event => event.mission?.envelopeId === 'env-b'));
  assert.ok(snapB.events.some(event => event.mission?.envelopeId === 'env-b'));
  assert.ok(!snapB.events.some(event => event.mission?.envelopeId === 'env-a'));

  const crossToken = await fetch('http://127.0.0.1:' + b.port + '/v1/live/snapshot', {
    headers: {
      Authorization: 'Bearer ' + a.token,
      'x-mcf-instance': 'notebook-team2',
    },
  });
  assert.equal(crossToken.status, 401);
});


test('bridge SSE replays events after cursor and stays read-only', async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcf-live-sse-'));
  const wc = {
    isDestroyed: () => false,
    getURL: () => 'https://chatgpt.test/',
    getTitle: () => 'chat',
    isLoading: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  };
  const bridge = new LocalAgentBridge({
    getWorkspaceWebContents: () => wc,
    getPaneWebContents: () => wc,
    captureDir: dir,
    instanceId: 'stream-test',
  });
  await bridge.start(0);
  t.after(async () => {
    await bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const first = bridge.publishLiveEvent({ type: 'MISSION_STATE', mission: { envelopeId: 'one' } });
  const second = bridge.publishLiveEvent({ type: 'AGENT_RECEIPT', receipt: { receiptId: 'two' } });

  const noAccept = await fetch('http://127.0.0.1:' + bridge.port + '/v1/live/stream', {
    headers: {
      Authorization: 'Bearer ' + bridge.token,
      'x-mcf-instance': 'stream-test',
    },
  });
  assert.equal(noAccept.status, 406);

  const controller = new AbortController();
  const response = await fetch('http://127.0.0.1:' + bridge.port + '/v1/live/stream?after=' + encodeURIComponent(first.eventId), {
    headers: {
      Authorization: 'Bearer ' + bridge.token,
      'x-mcf-instance': 'stream-test',
      Accept: 'text/event-stream',
    },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  for (let i = 0; i < 5 && !body.includes('"receiptId":"two"'); i += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  controller.abort();

  assert.ok(body.includes('event: channel.ready'));
  assert.ok(body.includes('id: ' + second.eventId));
  assert.ok(body.includes('"receiptId":"two"'));
  assert.ok(!body.includes('"envelopeId":"one"'));
});
