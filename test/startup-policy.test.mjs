import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conversationIdFromChatUrl,
  buildRestoreSafeStartupPlan,
} from '../src/main/startup-policy.mjs';

test('conversationIdFromChatUrl recognizes GPT and generic ChatGPT conversations', () => {
  assert.equal(
    conversationIdFromChatUrl('https://chatgpt.com/g/g-example-agent/c/abc-123'),
    'abc-123',
  );
  assert.equal(
    conversationIdFromChatUrl('https://chatgpt.com/c/xyz-789'),
    'xyz-789',
  );
  assert.equal(conversationIdFromChatUrl('https://chatgpt.com/g/g-example-agent/project'), null);
  assert.equal(conversationIdFromChatUrl('https://example.com/c/not-chatgpt'), null);
});

test('restore-safe startup defers identity bootstrap on persisted conversations', () => {
  const plan = buildRestoreSafeStartupPlan({
    chat: { url: 'https://chatgpt.com/g/g-emily/c/emily-conversation' },
    workspace: { url: 'https://chatgpt.com/g/g-sofia/c/sofia-conversation' },
  });

  assert.deepEqual(plan.deferredPanes, ['chat', 'workspace']);
  assert.deepEqual(plan.bootstrapPanes, []);
  assert.equal(plan.panes.chat.autoBootstrapAllowed, false);
  assert.equal(plan.panes.workspace.autoBootstrapAllowed, false);
});

test('restore-safe startup permits bootstrap only for panes without a restored conversation', () => {
  const plan = buildRestoreSafeStartupPlan({
    chat: { url: 'https://chatgpt.com/g/g-emily/c/emily-conversation' },
    workspace: { url: 'https://chatgpt.com/g/g-sofia/project' },
  });

  assert.deepEqual(plan.deferredPanes, ['chat']);
  assert.deepEqual(plan.bootstrapPanes, ['workspace']);
  assert.equal(plan.panes.chat.reason, 'restored_conversation_preserved');
  assert.equal(plan.panes.workspace.reason, 'no_restored_conversation');
});
