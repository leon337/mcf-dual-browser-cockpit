import test from 'node:test';
import assert from 'node:assert/strict';
import { isChatSnapshotIdle } from '../src/main/chatgpt-idle.mjs';

test('chat snapshot is idle only with no active generation and empty composer', () => {
  assert.equal(isChatSnapshotIdle(null), false);
  assert.equal(isChatSnapshotIdle({stop:true,composerText:''}), false);
  assert.equal(isChatSnapshotIdle({stop:false,composerText:'rascunho'}), false);
  assert.equal(isChatSnapshotIdle({stop:false,composerText:''}), true);
});
