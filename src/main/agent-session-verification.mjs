export const AGENT_SESSION_MARKER = '[MCF AGENT SESSION]';

export function buildAgentSessionDeliveryProbe(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) throw new Error('agent_session_id_required');

  return `(() => {
    const marker = ${JSON.stringify(AGENT_SESSION_MARKER)};
    const sessionId = ${JSON.stringify(normalizedSessionId)};
    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]');
    const composerText = composer
      ? String(composer.innerText || composer.value || composer.textContent || '')
      : '';
    const userMessages = [...document.querySelectorAll('[data-message-author-role="user"]')];
    const matchingUserTurns = userMessages.filter(node => {
      const text = String(node.innerText || node.textContent || '');
      return text.includes(marker) && text.includes(sessionId);
    });
    const conversationId = location.pathname.match(/\\/c\\/([^/]+)/)?.[1] ?? null;
    return {
      path: location.pathname,
      title: document.title,
      conversationId,
      composerPresent: Boolean(composer),
      composerTextLength: composerText.length,
      composerContainsBootstrap: composerText.includes(marker) || composerText.includes(sessionId),
      userTurnCount: userMessages.length,
      matchingUserTurnCount: matchingUserTurns.length,
      userMessageId: matchingUserTurns.at(-1)?.getAttribute('data-message-id') || null,
    };
  })()`;
}

export function isAgentSessionDeliveryConfirmed(evidence) {
  return Boolean(
    evidence
      && evidence.conversationId
      && evidence.matchingUserTurnCount === 1
      && evidence.composerContainsBootstrap === false
  );
}
