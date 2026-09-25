export function conversationIdFromChatUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.hostname !== 'chatgpt.com') return null;
    return url.pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function buildRestoreSafeStartupPlan(runtimeState, panes = ['chat', 'workspace']) {
  const panePlan = {};
  for (const pane of panes) {
    const url = runtimeState?.[pane]?.url ?? null;
    const conversationId = conversationIdFromChatUrl(url);
    panePlan[pane] = {
      pane,
      url,
      conversationId,
      restoredConversation: Boolean(conversationId),
      autoBootstrapAllowed: !conversationId,
      reason: conversationId
        ? 'restored_conversation_preserved'
        : 'no_restored_conversation',
    };
  }

  return {
    panes: panePlan,
    deferredPanes: panes.filter(pane => panePlan[pane]?.restoredConversation),
    bootstrapPanes: panes.filter(pane => panePlan[pane]?.autoBootstrapAllowed),
  };
}

function normalizeHttpUrl(value, fallback = null) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : fallback;
  } catch {
    return fallback;
  }
}

export function selectPersistedPaneUrl({
  liveUrl = null,
  restoredUrl = null,
  restoreComplete = true,
  fallback = null,
} = {}) {
  const normalizedRestored = normalizeHttpUrl(restoredUrl, fallback);
  if (!restoreComplete && conversationIdFromChatUrl(normalizedRestored)) {
    return normalizedRestored;
  }
  return normalizeHttpUrl(liveUrl, normalizedRestored ?? fallback);
}

