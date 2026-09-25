import test from 'node:test';
import assert from 'node:assert/strict';
import { isFreshConversationSurface } from '../src/main/fresh-conversation-policy.mjs';

test('fresh surface accepts the same GPT root and /project redirect', () => {
  const target = 'https://chatgpt.com/g/g-emily';
  assert.equal(isFreshConversationSurface(target, target), true);
  assert.equal(isFreshConversationSurface(target + '/project', target), true);
  assert.equal(isFreshConversationSurface(target + '/', target), true);
});

test('fresh surface rejects existing conversations and other GPT roots', () => {
  const target = 'https://chatgpt.com/g/g-emily';
  assert.equal(
    isFreshConversationSurface(target + '/c/12345678-1234-1234-1234-123456789abc', target),
    false,
  );
  assert.equal(isFreshConversationSurface('https://chatgpt.com/g/g-sofia/project', target), false);
  assert.equal(isFreshConversationSurface('https://example.com/g/g-emily/project', target), false);
});
