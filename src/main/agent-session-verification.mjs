export const AGENT_SESSION_MARKER = '[MCF AGENT SESSION]';

export function buildAgentSessionDeliveryProbe(sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId) throw new Error('agent_session_id_required');

  return `(() => {
    const marker = ${JSON.stringify(AGENT_SESSION_MARKER)};
    const sessionId = ${JSON.stringify(normalizedSessionId)};
    const composer = document.querySelector('[role="textbox"][contenteditable="true"][aria-label="Pergunte ao ChatGPT"]')
      || document.querySelector('[role="textbox"][contenteditable="true"][aria-label="Converse com o ChatGPT"]')
      || document.querySelector('#prompt-textarea')
      || document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]');
    const composerText = composer
      ? String(composer.innerText || composer.value || composer.textContent || '')
      : '';
    // Modern ChatGPT bubbles and old role markup are explicit turn anchors.
    // The accessible 'Você disse:' heading is a bounded fallback, not body text.
    const modernUserMessages = [...document.querySelectorAll('[data-user-message-bubble]')];
    const legacyUserMessages = [...document.querySelectorAll('[data-message-author-role="user"]')];
    let userMessages = modernUserMessages.length ? modernUserMessages : legacyUserMessages;
    if (!userMessages.length) {
      const headings = [...document.querySelectorAll('h4')]
        .filter(h => String(h.textContent || '').trim() === 'Você disse:');
      userMessages = headings.map(heading => {
        let parent = heading;
        for (let depth = 0; depth < 10; depth += 1) {
          parent = parent?.parentElement;
          if (!parent || parent === document.querySelector('body')) break;
          const headerNodes = [...parent.querySelectorAll('h4')];
          if (headerNodes.length !== 1 || headerNodes[0] !== heading) break;
          const text = String(parent.innerText || parent.textContent || '');
          if (text.includes(marker) && text.includes(sessionId)) return parent;
        }
        return null;
      }).filter(Boolean);
    }
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