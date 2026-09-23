import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { PrimaryMestreInbox } from '../src/main/primary-mestre-inbox.mjs';

test('persists and deduplicates relay messages by messageId', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mestre-inbox-'));
  const file = path.join(dir, 'inbox.json');
  try {
    const inbox = new PrimaryMestreInbox({ file, deliver: async () => ({ok:true}) });
    const a = inbox.enqueue({messageId:'m1',from:'ILHA_1',fromChatId:'c1',text:'oi'});
    const b = inbox.enqueue({messageId:'m1',from:'ILHA_1',fromChatId:'c1',text:'oi'});
    assert.equal(a.item.id, b.item.id);
    assert.equal(inbox.list().length, 1);
    const restored = new PrimaryMestreInbox({ file, deliver: async () => ({ok:true}) });
    assert.equal(restored.list().length, 1);
    assert.equal(restored.list()[0].state, 'PENDING');
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('marks delivery success and keeps deferred work pending', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mestre-inbox-'));
  const file = path.join(dir, 'inbox.json');
  let calls = 0;
  try {
    const inbox = new PrimaryMestreInbox({ file, deliver: async () => (++calls === 1 ? {deferred:true,reason:'busy'} : {ok:true,response:{text:'ack'}}) });
    inbox.enqueue({messageId:'m2',from:'ILHA_2',fromChatId:'c2',text:'fala'});
    await inbox.processOne();
    assert.equal(inbox.list()[0].state, 'PENDING');
    await inbox.processOne();
    assert.equal(inbox.list()[0].state, 'DELIVERED');
    assert.equal(calls, 2);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});

test('readiness deferral leaves pending item untouched and does not call delivery', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mestre-inbox-'));
  const file = path.join(dir, 'inbox.json');
  let deliveries = 0;
  try {
    const inbox = new PrimaryMestreInbox({
      file,
      canDeliver: async () => ({ready:false,reason:'mestre_busy'}),
      deliver: async () => { deliveries++; return {ok:true}; }
    });
    inbox.enqueue({messageId:'m3',from:'ILHA_1',fromChatId:'c1',text:'aguarde'});
    const before = inbox.list()[0];
    const result = await inbox.processOne();
    const after = inbox.list()[0];
    assert.equal(result.deferred, true);
    assert.equal(deliveries, 0);
    assert.equal(after.state, 'PENDING');
    assert.equal(after.attempts, 0);
    assert.equal(after.updatedAt, before.updatedAt);
  } finally { rmSync(dir, {recursive:true,force:true}); }
});
