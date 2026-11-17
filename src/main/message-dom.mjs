/**
 * DOM-only, read-only user-turn extraction. This function is serialized into
 * the page with .toString(), so keep it self-contained and free of imports.
 */
export function observeUserTurns(document, pane) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const nodes = pane === 'workspace'
    ? [...document.querySelectorAll('user-query-content')]
    : (() => {
        const modern = [...document.querySelectorAll('[data-user-message-bubble]')];
        return modern.length ? modern
          : [...document.querySelectorAll('[data-message-author-role="user"]')];
      })();
  const getText = node => {
    if (pane !== 'workspace') return normalize(node?.innerText || node?.textContent);
    const raw = String(node?.querySelector?.('.query-content')?.innerText
      || node?.innerText || node?.textContent || '');
    // Gemini renders "Você disse <preview>\n\n<full prompt>" in the
    // same user-query-content; the last section contains the actual turn.
    const sections = raw.split(/\n\s*\n/).map(normalize).filter(Boolean);
    return sections.at(-1) || normalize(raw);
  };
  const turns = nodes.map(node => ({ node, text: getText(node) }))
    .filter(turn => turn.text.length > 0);
  const latest = turns.at(-1) || null;
  const text = latest?.text || '';
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const lastUserMessageId = latest?.node?.getAttribute?.('data-message-id')
    || latest?.node?.closest?.('[data-chatgpt-search-message-ids]')
      ?.getAttribute?.('data-chatgpt-search-message-ids')
    || null;
  return {
    userMessageCount: turns.length,
    lastUserMessageId,
    lastUserSignature: text ? text.length + ':' + (hash >>> 0).toString(16) : null,
    lastUserText: text,
  };
}

/**
 * Pure, conservative post-send check. Empty composer alone never proves
 * delivery. Repeated identical content without a new turn never passes.
 */
export function verifyUserTurnDelivery({
  pane, baseline, observation, expectedMessage, composerCleared, url,
} = {}) {
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
  const before = baseline || {};
  const now = observation || {};
  const expected = normalize(expectedMessage);
  const latest = normalize(now.lastUserText);
  const baselineUrl = String(before.url || '');
  const actualUrl = String(url || '');
  const gemini = pane === 'workspace';
  const extractId = (value, regex) => value.match(regex)?.[1] || null;
  const baseConversation = extractId(baselineUrl, gemini ? /\/app\/([^/?#]+)/ : /\/c\/([^/?#]+)/);
  const actualConversation = extractId(actualUrl, gemini ? /\/app\/([^/?#]+)/ : /\/c\/([^/?#]+)/);
  const conversationBindingPreserved = !baseConversation
    || actualConversation === baseConversation;
  const changedId = Boolean(now.lastUserMessageId)
    && now.lastUserMessageId !== (before.lastUserMessageId || null);
  const increasedCount = Number(now.userMessageCount || 0)
    > Number(before.userMessageCount || 0);
  const changedSignature = Boolean(now.lastUserSignature)
    && now.lastUserSignature !== (before.lastUserSignature || null);
  const newChatConversation = !gemini
    && actualUrl !== baselineUrl && /\/c\/[^/]+/.test(actualUrl);
  const conversationAdvanced = changedId || increasedCount
    || (gemini && changedSignature) || newChatConversation;
  const messageMatchesLastUserTurn = Boolean(expected)
    && (latest === expected || (gemini && latest.endsWith(' ' + expected)));
  const sent = Boolean(composerCleared) && conversationAdvanced
    && messageMatchesLastUserTurn && conversationBindingPreserved;
  return { sent, conversationAdvanced, messageMatchesLastUserTurn,
    conversationBindingPreserved };
}

/**
 * Read-only generation sample, serialized into page.
 * "Parar resposta" means generation is active; not a stop permission.
 */
export function sampleGenerationDOM(document) {
  const visible = el => {
    if (!el) return false;
    const rect = el.getBoundingClientRect?.();
    const style = getComputedStyle(el);
    return Boolean(rect && rect.width > 10 && rect.height > 10
      && style.display !== 'none' && style.visibility !== 'hidden');
  };
  const buttons = [...document.querySelectorAll('button')];
  const stop = buttons.find(button => visible(button) &&
    /^(parar resposta|parar de responder|stop generating|stop responding|stop response)$/i
      .test(String(button.getAttribute('aria-label') || button.title || '').trim()));
  // Text is used only for a hash; never return it to the caller.
  const responseText = [...document.querySelectorAll('model-response, .model-response-text, .response-container')]
    .filter(visible).at(-1)?.innerText || '';
  const statusText = String(document.body?.innerText || '').slice(-300);
  const isThinking = /\bpensando(?:\.\.\.|…)/i.test(statusText);
  let hash = 2166136261;
  const relevant = String(responseText).slice(-16000) + '\n' + statusText;
  for (let i = 0; i < relevant.length; i += 1) {
    hash ^= relevant.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    generationActive: Boolean(stop),
    stopLabel: stop?.getAttribute('aria-label') || null,
    thinkingVisible: isThinking,
    fingerprint: (hash >>> 0).toString(16),
    responseLength: responseText.length,
    url: location.href,
  };
}

/**
 * A threshold is advisory, never an automatic cancellation.
 * Samples from a different URL or a changed fingerprint reset the clock.
 */
export class GenerationStallTracker {
  constructor({ thresholdMs = 90000, clock = () => Date.now() } = {}) {
    this.thresholdMs = Math.max(1000, Number(thresholdMs) || 90000);
    this.clock = clock;
    this.states = new Map();
  }
  observe(pane, sample) {
    if (!['chat', 'workspace'].includes(pane) || !sample?.url) {
      return { ok: false, error: 'invalid_generation_sample' };
    }
    const now = this.clock();
    const old = this.states.get(pane);
    const same = Boolean(old && old.url === sample.url
      && old.fingerprint === sample.fingerprint && sample.generationActive);
    const since = same ? old.since : now;
    if (sample.generationActive) this.states.set(pane, {
      since, url: sample.url, fingerprint: sample.fingerprint,
    });
    else this.states.delete(pane);
    const stableForMs = sample.generationActive ? Math.max(0, now - since) : 0;
    const suspectedStall = Boolean(sample.generationActive && sample.thinkingVisible
      && stableForMs >= this.thresholdMs);
    return {
      ok: true, pane, generationActive: Boolean(sample.generationActive),
      suspectedStall, stableForMs, thresholdMs: this.thresholdMs,
      fingerprint: sample.fingerprint, url: sample.url,
      // Observation is not proof of a frozen model.
      recovery: suspectedStall ? 'explicit_confirmation_required' : 'not_eligible',
    };
  }
  clear(pane) { this.states.delete(pane); }
}
