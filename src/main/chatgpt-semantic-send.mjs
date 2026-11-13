/**
 * Semantic ChatGPT send control. Strings are exact, versionable accessibility
 * aliases, not generated CSS classes or screen coordinates.
 *
 * Both functions are self-contained for injection through WebContents.
 */
export function resolveChatGPTSendButton(doc) {
  const view = doc?.defaultView;
  const visible = el => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    const style = view?.getComputedStyle?.(el);
    return rect.width > 10 && rect.height > 10
      && style?.display !== 'none' && style?.visibility !== 'hidden';
  };
  const sendLabels = new Set([
    'enviar', 'enviar mensagem', 'send', 'send message',
  ]);
  const explicitIds = new Set(['send-button', 'composer-submit-button']);
  const isSend = b => {
    if (!b || b.tagName?.toLowerCase() !== 'button') return false;
    const id = String(b.id || '').trim();
    const testId = String(b.getAttribute?.('data-testid') || '').trim();
    const label = String(b.getAttribute?.('aria-label') || b.title || '').trim().toLocaleLowerCase();
    const declaredSend = explicitIds.has(id) || explicitIds.has(testId)
      || sendLabels.has(label);
    const blocked = b.disabled === true || b.getAttribute?.('aria-disabled') === 'true';
    const stopState = /^(parar de responder|stop|stop generating|stop generation)$/i.test(label);
    return declaredSend && !blocked && !stopState && visible(b);
  };
  const buttons = [...doc.querySelectorAll('button')];
  const stopControl = buttons.find(b => {
    const label = String(b?.getAttribute?.('aria-label') || b?.title || '').trim().toLowerCase();
    const testId = String(b?.getAttribute?.('data-testid') || '').trim().toLowerCase();
    return visible(b) && (
      /^(parar de responder|stop|stop generating|stop generation)$/.test(label)
      || testId === 'stop-button'
    );
  });
  if (stopControl) return { ok: false, error: 'message_send_blocked_generation_active' };
  const candidates = buttons.filter(isSend);
  if (candidates.length > 1) return { ok: false, error: 'chat_send_control_ambiguous' };
  if (!candidates.length) return { ok: false, error: 'chat_send_control_not_found' };
  return { ok: true, element: candidates[0] };
}

export async function clickChatGPTSendOnce(wc, { timeoutMs = 3500, pollMs = 150 } = {}) {
  if (!wc || wc.isDestroyed?.() || typeof wc.executeJavaScript !== 'function') {
    return { ok: false, error: 'chat_send_surface_unavailable' };
  }
  const deadline = Date.now() + timeoutMs;
  let last = null;
  do {
    // Resolution and click happen in the SAME DOM tick; no stale locator action.
    last = await wc.executeJavaScript(`(() => {
      const resolve = ${resolveChatGPTSendButton.toString()};
      const control = resolve(document);
      if (!control.ok) return { ok:false, error:control.error };
      control.element.click();
      return { ok:true, method:'semantic-button', semanticId:'chatgpt.composer.submit' };
    })()`, true).catch(() => ({ ok: false, error: 'chat_send_effect_unknown' }));
    if (last.ok) return last;
    // Ambiguity or an exception after an attempted click must never be retried.
    if (last.error !== 'chat_send_control_not_found') return last;
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (Date.now() < deadline);
  return last ?? { ok:false, error:'chat_send_control_not_found' };
}

/**
 * Resolve one editable ChatGPT composer. Strong selectors are exact semantic
 * aliases, and ambiguous selections fail closed (no first-match fallback).
 * Self-contained for WebContents injection.
 */
export function resolveChatGPTComposer(doc) {
  const visible = el => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    const css = doc?.defaultView?.getComputedStyle?.(el);
    return rect.width > 20 && rect.height > 10
      && css?.display !== 'none' && css?.visibility !== 'hidden';
  };
  const editable = el => el && !el.disabled && !el.readOnly
    && el.getAttribute?.('aria-disabled') !== 'true'
    && el.getAttribute?.('contenteditable') !== 'false'
    && (el.isContentEditable === true || el.getAttribute?.('contenteditable') === 'true'
        || el.tagName?.toLowerCase() === 'textarea');
  const strongSelectors = [
    '[role="textbox"][contenteditable="true"][aria-label="Pergunte ao ChatGPT"]',
    '[role="textbox"][contenteditable="true"][aria-label="Converse com o ChatGPT"]',
    '#prompt-textarea',
    'textarea[aria-label="Pergunte ao ChatGPT"]',
    'textarea[aria-label="Converse com o ChatGPT"]',
  ];
  const strong = [...new Set(strongSelectors.flatMap(s => [...doc.querySelectorAll(s)]))]
    .filter(el => visible(el) && editable(el));
  if (strong.length > 1) return { ok:false, error:'chat_composer_ambiguous' };
  if (strong.length === 1) return { ok:true, element:strong[0] };
  const fallback = [...new Set([...doc.querySelectorAll('textarea,[contenteditable="true"]')])]
    .filter(el => visible(el) && editable(el));
  if (fallback.length > 1) return { ok:false, error:'chat_composer_ambiguous' };
  if (!fallback.length) return { ok:false, error:'chat_composer_not_found' };
  return { ok:true, element:fallback[0] };
}
