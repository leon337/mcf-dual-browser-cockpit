import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LiveAgentEventBus } from '../src/main/live-agent-events.mjs';

function makeStream() {
  const req = new EventEmitter();
  req.socket = { setTimeout() {} };
  const res = new EventEmitter();
  res.writableEnded = false;
  res.destroyed = false;
  res.chunks = [];
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.setTimeout = () => {};
  res.flushHeaders = () => {};
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.writableEnded = true; };
  return { req, res };
}

test('snapshot replays events after a valid cursor', () => {
  const bus = new LiveAgentEventBus({ instanceId: 'test-instance', bootId: 'boot-test' });
  const first = bus.publish({ type: 'NAVIGATION_STARTED', pane: 'workspace' });
  const second = bus.publish({ type: 'NAVIGATION_FINISHED', pane: 'workspace' });
  const snapshot = bus.snapshot(first.eventId);
  assert.equal(snapshot.resetRequired, false);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].eventId, second.eventId);
});

test('SSE stream emits ready, replay, and live events then cleans up on disconnect', () => {
  const bus = new LiveAgentEventBus({ instanceId: 'test-instance', bootId: 'boot-test', heartbeatMs: 60000 });
  bus.publish({ type: 'BEFORE_CONNECT', safe: true });
  const { req, res } = makeStream();
  const result = bus.attach(req, res, {});
  assert.equal(result.ok, true);
  assert.match(res.chunks.join(''), /event: channel.ready/);
  assert.match(res.chunks.join(''), /event: before_connect/);
  bus.publish({ type: 'NAVIGATION_FINISHED', pane: 'workspace' });
  assert.match(res.chunks.join(''), /event: navigation_finished/);
  req.emit('close');
  assert.equal(bus.clients.size, 0);
});

test('expired cursors request a replay reset after bounded-buffer eviction', () => {
  const bus = new LiveAgentEventBus({ instanceId: 'test-instance', bootId: 'boot-test', limit: 8 });
  bus.publish({ type: 'FIRST' });
  for (let i = 0; i < 10; i += 1) bus.publish({ type: 'EVENT', index: i });
  const snapshot = bus.snapshot('boot-test:1');
  assert.equal(snapshot.resetRequired, true);
  assert.equal(snapshot.resetReason, 'cursor_expired');
});


test('expired cursor resets when age eviction empties the buffer', () => {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  const bus = new LiveAgentEventBus({
    instanceId: 'test-instance',
    bootId: 'boot-test',
    maxAgeMs: 1000,
    now: () => new Date(nowMs).toISOString(),
  });
  const cursor = bus.publish({ type: 'FIRST' }).eventId;
  nowMs += 100;
  bus.publish({ type: 'SECOND' });
  nowMs += 2000;
  const snapshot = bus.snapshot(cursor);
  assert.equal(snapshot.events.length, 0);
  assert.equal(snapshot.resetRequired, true);
  assert.equal(snapshot.resetReason, 'cursor_expired');
});

test('published event identity and sequence cannot be overridden by caller payload', () => {
  const bus = new LiveAgentEventBus({ instanceId: 'test-instance', bootId: 'boot-test' });
  const event = bus.publish({
    type: 'CANONICAL_EVENT',
    schema: 'spoofed-schema',
    eventId: 'spoofed-id',
    sequence: 900,
    bootId: 'spoofed-boot',
    instanceId: 'spoofed-instance',
    agentProfile: 'spoofed-profile',
  });
  assert.equal(event.schema, 'mcf-live-agent-event/v1');
  assert.equal(event.eventId, 'boot-test:1');
  assert.equal(event.sequence, 1);
  assert.equal(event.bootId, 'boot-test');
  assert.equal(event.instanceId, 'test-instance');
  assert.equal(event.agentProfile, null);
  assert.equal(bus.snapshot().highWatermarkEventId, 'boot-test:1');
});