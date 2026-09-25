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
