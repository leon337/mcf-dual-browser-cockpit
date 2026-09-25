export const PANE_IDENTITY_HEADER = '[MCF PANE AGENT IDENTITY]';

export function buildIdentityBootstrapProbe({
  agentId,
  sessionId,
  contractDigest,
  marker,
  userMessageId = null,
  expectedConversationUrl = null,
  expectedProjectRoot = null,
} = {}) {
  if (!agentId || !sessionId || !contractDigest || !marker) {
    throw new Error('identity_bootstrap_probe_invalid');
  }

  return `(() => {
    const agentId = ${JSON.stringify(String(agentId))};
    const sessionId = ${JSON.stringify(String(sessionId))};
    const contractDigest = ${JSON.stringify(String(contractDigest))};
    const marker = ${JSON.stringify(String(marker))};
    const expectedUserMessageId = ${JSON.stringify(userMessageId ? String(userMessageId) : null)};
    const expectedConversationUrl = ${JSON.stringify(expectedConversationUrl ? String(expectedConversationUrl) : null)};
    const expectedProjectRoot = ${JSON.stringify(expectedProjectRoot ? String(expectedProjectRoot) : null)};
    const header = ${JSON.stringify(PANE_IDENTITY_HEADER)};
    const agentNeedle = 'agent_id: ' + agentId;
    const sessionNeedle = 'session_id: ' + sessionId;
    const digestNeedle = 'contract_sha256: ' + contractDigest;
    const textOf = node => String(node?.innerText || node?.textContent || '');

    const composer = document.querySelector('#prompt-textarea')
      || document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"]');
    const composerText = composer
      ? String(composer.innerText || composer.value || composer.textContent || '')
      : '';
    const composerContainsBootstrap = composerText.includes(header)
      || composerText.includes(sessionNeedle)
      || composerText.includes(marker);

    const roleMessages = [...document.querySelectorAll('[data-message-author-role]')];
    const roleUsers = roleMessages.filter(node =>
      node.getAttribute('data-message-author-role') === 'user'
    );

    const rawTurns = [...document.querySelectorAll(
      'section[data-testid^="conversation-turn-"], article[data-testid^="conversation-turn-"]'
    )];
    const turns = rawTurns.filter((node, index, all) =>
      !all.some((other, otherIndex) =>
        otherIndex !== index && other.contains(node)
      )
    );

    const isIdentityAttempt = node => {
      const text = textOf(node);
      return text.includes(header) && text.includes(agentNeedle);
    };
    const isExactIdentity = node => {
      const text = textOf(node);
      return isIdentityAttempt(node)
        && text.includes(sessionNeedle)
        && text.includes(digestNeedle);
    };

    const roleIdentityAttempts = roleUsers.filter(isIdentityAttempt);
    const roleMatches = roleIdentityAttempts.filter(isExactIdentity);
    const turnIdentityAttempts = turns.filter(isIdentityAttempt);
    const turnMatches = turnIdentityAttempts.filter(isExactIdentity);

    let source = null;
    let anchor = null;
    let collection = null;
    let identityAttempts = [];

    if (expectedUserMessageId) {
      anchor = roleMatches.find(node =>
        node.getAttribute('data-message-id') === expectedUserMessageId
      ) || null;
      if (anchor) {
        source = 'role-message';
        collection = roleMessages;
        identityAttempts = roleIdentityAttempts;
      }
    }

    if (!anchor && roleMatches.length === 1) {
      anchor = roleMatches[0];
      source = 'role-message';
      collection = roleMessages;
      identityAttempts = roleIdentityAttempts;
    }

    if (!anchor && turnMatches.length === 1) {
      anchor = turnMatches[0];
      source = 'conversation-turn';
      collection = turns;
      identityAttempts = turnIdentityAttempts;
    }

    const userAnchorFound = Boolean(anchor);
    const conflictingAttempt = userAnchorFound
      ? identityAttempts.some(node => node !== anchor)
      : (roleIdentityAttempts.length > 1 || turnIdentityAttempts.length > 1);

    let markerNode = null;
    if (anchor && collection) {
      const anchorIndex = collection.indexOf(anchor);
      for (let index = anchorIndex + 1; index < collection.length; index += 1) {
        const node = collection[index];
        if (source === 'role-message'
            && node.getAttribute('data-message-author-role') === 'user') {
          break;
        }
        if (source === 'conversation-turn' && isIdentityAttempt(node)) {
          break;
        }
        const role = node.getAttribute?.('data-message-author-role');
        const canCarryAssistantMarker = source === 'conversation-turn' || role === 'assistant';
        if (canCarryAssistantMarker && textOf(node).includes(marker)) {
          markerNode = node;
          break;
        }
      }
    }

    const markerObserved = Boolean(markerNode);
    const url = location.href;

    const rootOf = value => {
      if (!value) return null;
      try {
        const parsed = new URL(value);
        let path = parsed.pathname;
        path = path.replace(/\\/project\\/?$/, '');
        path = path.replace(/\\/c\\/[^/]+.*$/, '');
        path = path.replace(/\\/$/, '');
        return parsed.origin + path;
      } catch {
        return null;
      }
    };

    const currentRoot = rootOf(url);
    const expectedConversationRoot = rootOf(expectedConversationUrl);
    const expectedProjectNormalizedRoot = rootOf(expectedProjectRoot);

    const conversationUrlOk = !expectedConversationUrl
      || url === expectedConversationUrl
      || Boolean(currentRoot && expectedConversationRoot && currentRoot === expectedConversationRoot);

    const projectRootOk = !expectedProjectRoot
      || url === expectedProjectRoot
      || Boolean(currentRoot && expectedProjectNormalizedRoot && currentRoot === expectedProjectNormalizedRoot);

    const verified = userAnchorFound
      && markerObserved
      && !conflictingAttempt
      && !composerContainsBootstrap
      && conversationUrlOk
      && projectRootOk;

    const messageIdOf = node => {
      if (!node) return null;
      return node.getAttribute?.('data-message-id')
        || node.querySelector?.('[data-message-id]')?.getAttribute('data-message-id')
        || null;
    };

    return {
      ok: true,
      verified,
      source,
      userAnchorFound,
      markerObserved,
      conflictingAttempt,
      composerContainsBootstrap,
      matchingUserCount: source === 'role-message' ? roleMatches.length : turnMatches.length,
      identityAttemptCount: identityAttempts.length,
      roleMatchCount: roleMatches.length,
      turnMatchCount: turnMatches.length,
      conversationUrlOk,
      projectRootOk,
      userMessageId: messageIdOf(anchor),
      assistantMessageId: messageIdOf(markerNode),
      url,
      error: verified
        ? null
        : composerContainsBootstrap
          ? 'identity_bootstrap_still_in_composer'
          : conflictingAttempt
            ? 'identity_bootstrap_conflicting_attempt'
            : !userAnchorFound
              ? 'identity_bootstrap_user_anchor_not_found'
              : !markerObserved
                ? 'identity_bootstrap_marker_not_linked'
                : !conversationUrlOk
                  ? 'identity_bootstrap_conversation_mismatch'
                  : 'identity_bootstrap_project_mismatch',
    };
  })()`;
}

export function isIdentityBootstrapEvidenceVerified(evidence) {
  return Boolean(
    evidence
      && evidence.ok === true
      && evidence.verified === true
      && evidence.userAnchorFound === true
      && evidence.markerObserved === true
      && evidence.conflictingAttempt !== true
      && evidence.composerContainsBootstrap !== true
      && evidence.conversationUrlOk !== false
      && evidence.projectRootOk !== false
  );
}
