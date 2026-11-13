import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRendererEventSend } from '../src/main/safe-renderer-event.mjs';

test('sends normal UI events exactly once', () => {
  let calls = 0;
  const webContents = { isDestroyed: () => false, send: (channel, payload) => {
    calls++;
    assert.equal(channel, 'bridge:event');
    assert.deepEqual(payload, { state: 'READY' });
  } };
  assert.equal(safeRendererEventSend(webContents, 'bridge:event', { state:'READY' }), true);
  assert.equal(calls, 1);
});

test('disposed frame between check and send does not crash parent runtime', () => {
  const webContents = {
    isDestroyed: () => false,
    send: () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed'); },
  };
  assert.equal(safeRendererEventSend(webContents, 'bridge:event', {}), false);
});

test('already destroyed webcontents is not used', () => {
  let invoked = false;
  const webContents = { isDestroyed: () => true, send: () => { invoked = true; } };
  assert.equal(safeRendererEventSend(webContents, 'browser:state', {}), false);
  assert.equal(invoked, false);
});

test('unexpected send errors are not hidden', () => {
  const webContents = { isDestroyed: () => false, send: () => { throw new Error('unexpected protocol failure'); } };
  assert.throws(() => safeRendererEventSend(webContents, 'bridge:event', {}), /unexpected protocol failure/);
});
