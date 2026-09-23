function isMestre(record) {
  return String(record?.agentId || '').trim().toUpperCase() === 'MESTRE';
}

export function extractChatGPTConversationId(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (url.hostname !== 'chatgpt.com' && !url.hostname.endsWith('.chatgpt.com')) return null;
    const match = url.pathname.match(/^\/c\/([^/]+)/u);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function buildPrimaryLink(record, instanceId, chatUrl) {
  const effectiveUrl = chatUrl || record?.chatUrl || null;
  return {
    sessionId: record?.sessionId,
    traceId: record?.traceId ?? null,
    missionId: record?.missionId ?? null,
    agentId: 'MESTRE',
    displayName: record?.displayName || 'MESTRE',
    role: record?.role ?? null,
    contractRef: record?.contractRef ?? null,
    contractDigest: record?.contractDigest ?? null,
    surface: record?.surface || 'chatgpt',
    surfaceState: record?.surfaceState || 'OPEN',
    chatUrl: effectiveUrl,
    createdAt: record?.createdAt ?? null,
    updatedAt: record?.updatedAt ?? null,
    instanceId,
    conversationId: extractChatGPTConversationId(effectiveUrl),
    primary: true,
  };
}

export async function ensurePrimaryMestreSession({
  instanceId,
  restored = null,
  chatUrl = null,
  loadSession,
  createSession,
  markOpen,
}) {
  let record = null;
  const restoredMatchesInstance = !restored?.instanceId || restored.instanceId === instanceId;
  if (restored?.sessionId && restoredMatchesInstance && typeof loadSession === 'function') {
    try {
      const candidate = await loadSession(restored.sessionId);
      if (candidate?.sessionId === restored.sessionId && isMestre(candidate)) record = candidate;
    } catch {}
  }

  if (!record) {
    record = await createSession();
    if (!record?.sessionId || !isMestre(record)) throw new Error('invalid_primary_mestre_session');
  }

  const restoredCanonicalUrl = restored?.conversationId && restored?.chatUrl ? restored.chatUrl : null;
  const recordCanonicalUrl = extractChatGPTConversationId(record?.chatUrl) ? record.chatUrl : null;
  const effectiveUrl = restoredCanonicalUrl || recordCanonicalUrl || chatUrl || record.chatUrl || null;
  if (effectiveUrl && typeof markOpen === 'function') {
    const opened = await markOpen(record.sessionId, effectiveUrl);
    if (opened?.sessionId === record.sessionId && isMestre(opened)) record = { ...record, ...opened };
  }
  return buildPrimaryLink(record, instanceId, effectiveUrl);
}

export async function syncPrimaryMestreSession({ current, chatUrl, markOpen }) {
  if (!current?.sessionId || !isMestre(current)) throw new Error('primary_mestre_session_required');
  const candidateUrl = chatUrl || current.chatUrl || null;
  const candidateConversationId = extractChatGPTConversationId(candidateUrl);
  if (current.conversationId && candidateConversationId !== current.conversationId) return current;
  const effectiveUrl = candidateUrl;
  if (effectiveUrl === current.chatUrl) return current;

  let record = current;
  if (effectiveUrl && typeof markOpen === 'function') {
    const opened = await markOpen(current.sessionId, effectiveUrl);
    if (opened?.sessionId === current.sessionId && isMestre(opened)) record = { ...current, ...opened };
  }
  return buildPrimaryLink(record, current.instanceId, effectiveUrl);
}
