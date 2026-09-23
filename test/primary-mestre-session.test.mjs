import { test } from 'node:test';
import assert from 'node:assert/strict';

async function loadFeature() {
  try {
    return await import('../src/main/primary-mestre-session.mjs');
  } catch {
    return {};
  }
}

function mestreRecord(overrides = {}) {
  return {
    sessionId: 'mestre-session-1',
    traceId: 'trace-1',
    agentId: 'MESTRE',
    displayName: 'MESTRE',
    role: 'Ponte oficial e orquestração',
    surface: 'chatgpt',
    surfaceState: 'PENDING_OPEN',
    createdAt: '2026-09-22T20:00:00-03:00',
    updatedAt: '2026-09-22T20:00:00-03:00',
    ...overrides,
  };
}

test('creates one canonical MESTRE session for the primary cockpit surface', async () => {
  const feature = await loadFeature();
  assert.equal(typeof feature.ensurePrimaryMestreSession, 'function');
  let creates = 0;
  const result = await feature.ensurePrimaryMestreSession({
    instanceId: 'archipelago-linux-clean2',
    restored: null,
    chatUrl: 'https://chatgpt.com/c/abc123',
    loadSession: async () => null,
    createSession: async () => { creates++; return mestreRecord(); },
    markOpen: async (_sessionId, chatUrl) => mestreRecord({chatUrl, surfaceState:'OPEN'}),
  });
  assert.equal(creates, 1);
  assert.equal(result.sessionId, 'mestre-session-1');
  assert.equal(result.instanceId, 'archipelago-linux-clean2');
  assert.equal(result.conversationId, 'abc123');
  assert.equal(result.primary, true);
});

test('reuses the restored MESTRE session instead of creating a duplicate', async () => {
  const feature = await loadFeature();
  let creates = 0;
  const result = await feature.ensurePrimaryMestreSession({
    instanceId: 'archipelago-linux-clean2',
    restored: {sessionId:'mestre-session-1'},
    chatUrl: 'https://chatgpt.com/c/abc123',
    loadSession: async id => id === 'mestre-session-1' ? mestreRecord() : null,
    createSession: async () => { creates++; return mestreRecord({sessionId:'new-session'}); },
    markOpen: async (_sessionId, chatUrl) => mestreRecord({chatUrl, surfaceState:'OPEN'}),
  });
  assert.equal(creates, 0);
  assert.equal(result.sessionId, 'mestre-session-1');
});

test('updates conversation linkage without rotating the MESTRE session id', async () => {
  const feature = await loadFeature();
  let marked = 0;
  const current = {
    ...mestreRecord({surfaceState:'OPEN'}),
    instanceId:'archipelago-linux-clean2',
    chatUrl:'https://chatgpt.com/',
    conversationId:null,
    primary:true,
  };
  const result = await feature.syncPrimaryMestreSession({
    current,
    chatUrl:'https://chatgpt.com/c/new-conversation',
    markOpen: async (_sessionId, chatUrl) => { marked++; return mestreRecord({chatUrl, surfaceState:'OPEN'}); },
  });
  assert.equal(marked, 1);
  assert.equal(result.sessionId, 'mestre-session-1');
  assert.equal(result.conversationId, 'new-conversation');
});

test('ignores a restored session that is not MESTRE', async () => {
  const feature = await loadFeature();
  let creates = 0;
  const result = await feature.ensurePrimaryMestreSession({
    instanceId:'archipelago-linux-clean2',
    restored:{sessionId:'rafael-session'},
    chatUrl:'https://chatgpt.com/c/abc123',
    loadSession: async () => mestreRecord({sessionId:'rafael-session',agentId:'Rafael'}),
    createSession: async () => { creates++; return mestreRecord({sessionId:'mestre-session-2'}); },
    markOpen: async (sessionId, chatUrl) => mestreRecord({sessionId,chatUrl,surfaceState:'OPEN'}),
  });
  assert.equal(creates, 1);
  assert.equal(result.sessionId, 'mestre-session-2');
  assert.equal(result.agentId, 'MESTRE');
});

test('does not reuse a MESTRE session restored from another cockpit instance', async () => {
  const feature = await loadFeature();
  let creates = 0;
  const result = await feature.ensurePrimaryMestreSession({
    instanceId:'archipelago-linux-clean2',
    restored:{sessionId:'foreign-session',instanceId:'other-cockpit'},
    chatUrl:'https://chatgpt.com/c/abc123',
    loadSession: async () => mestreRecord({sessionId:'foreign-session'}),
    createSession: async () => { creates++; return mestreRecord({sessionId:'local-session'}); },
    markOpen: async (sessionId, chatUrl) => mestreRecord({sessionId,chatUrl,surfaceState:'OPEN'}),
  });
  assert.equal(creates, 1);
  assert.equal(result.sessionId, 'local-session');
  assert.equal(result.instanceId, 'archipelago-linux-clean2');
});

test('does not rebind canonical MESTRE when the visible pane navigates to an island chat', async () => {
  const feature = await loadFeature();
  let marked = 0;
  const current = {
    ...mestreRecord({surfaceState:'OPEN'}),
    instanceId:'archipelago-linux-clean2',
    chatUrl:'https://chatgpt.com/c/mestre-canonical',
    conversationId:'mestre-canonical',
    primary:true,
  };
  const result = await feature.syncPrimaryMestreSession({
    current,
    chatUrl:'https://chatgpt.com/c/island-chat',
    markOpen: async () => { marked++; return mestreRecord(); },
  });
  assert.equal(marked, 0);
  assert.equal(result.chatUrl, 'https://chatgpt.com/c/mestre-canonical');
  assert.equal(result.conversationId, 'mestre-canonical');
});

test('startup prefers restored canonical MESTRE chat over currently visible island chat', async () => {
  const feature = await loadFeature();
  let markedUrl = null;
  const restored = {
    sessionId:'mestre-session-1',
    instanceId:'archipelago-linux-clean2',
    chatUrl:'https://chatgpt.com/c/mestre-canonical',
    conversationId:'mestre-canonical'
  };
  const result = await feature.ensurePrimaryMestreSession({
    instanceId:'archipelago-linux-clean2',
    restored,
    chatUrl:'https://chatgpt.com/c/island-visible',
    loadSession: async () => mestreRecord({chatUrl:'https://chatgpt.com/c/mestre-canonical'}),
    createSession: async () => mestreRecord({sessionId:'new-session'}),
    markOpen: async (_sessionId, chatUrl) => { markedUrl = chatUrl; return mestreRecord({chatUrl,surfaceState:'OPEN'}); },
  });
  assert.equal(markedUrl, 'https://chatgpt.com/c/mestre-canonical');
  assert.equal(result.conversationId, 'mestre-canonical');
});
