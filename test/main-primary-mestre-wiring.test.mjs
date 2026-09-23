import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync(new URL('../src/main/main.mjs', import.meta.url), 'utf8');

test('main cockpit wires the persistent primary MESTRE session', () => {
  assert.match(main, /ensurePrimaryMestreSession/);
  assert.match(main, /syncPrimaryMestreSession/);
  assert.match(main, /mestreSession:/);
  assert.match(main, /ensurePrimaryMestreRuntimeSession\(\)/);
  assert.match(main, /syncPrimaryMestreFromChat\(\)/);
});

test('syntax check includes the primary MESTRE module', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.check, /primary-mestre-session\.mjs/);
});

test('startup performs a post-create chat sync to close the initial navigation race', () => {
  assert.match(main, /agentSessionRuntime\.set\(link\.sessionId, primaryMestreSession\);[\s\S]{0,300}await syncPrimaryMestreFromChat\(\)/);
});


test('bridge wires chat-surface navigation to the primary ChatGPT pane', () => {
  assert.match(main, /async function openPrimaryChatSurface/);
  assert.match(main, /openChatSurface:\s*openPrimaryChatSurface/);
});

test('main cockpit wires persistent MESTRE inbox delivery worker', () => {
  assert.match(main, /PrimaryMestreInbox/);
  assert.match(main, /deliverPrimaryMestreInboxItem/);
  assert.match(main, /enqueueMestreInboxMessage:/);
  assert.match(main, /listMestreInbox:/);
  assert.match(main, /primaryMestreInboxTimer/);
});

test('syntax check includes MESTRE inbox and ChatGPT idle modules', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.check, /primary-mestre-inbox\.mjs/);
  assert.match(pkg.scripts.check, /chatgpt-idle\.mjs/);
});
