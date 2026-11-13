# ChatGPT Semantic Send — Compatibility Fix (2026-11-13)

**Status:** Candidate patch for review, not installed/deployed.
**Companion MCF PR:** https://github.com/leon337/multiagent-collaboration-framework/pull/520

## Observed incident (live Cockpit v0.7.4)

- An independent Sofia Agent Session was created for `MCF-CHATGPT-GATEWAY-E2E-20261113-001`, but bootstrap returned `chat_send_control_not_found`.
- Browser UI verification showed an editor with `role=textbox`, `contenteditable=true`, accessible name `Pergunte ao ChatGPT`, plus `button[aria-label=Enviar]`.
- Legacy `#prompt-textarea` and `[data-testid=send-button]` were not present.
- A single semantically resolved send click created a real conversation and an assistant reply, but the existing Bridge record was still `FAILED`. It was not promoted to `READY`.
- A follow-up analytic task completed in ChatGPT, but was sent through controlled UI recovery rather than a canonical Agent Session task API. No claim of end-to-end autonomous Gateway delivery is made.

## Patch

1. Add reusable, exact semantic aliases for visible, enabled ChatGPT send buttons (`Enviar`, `Send`, legacy test IDs); fail closed for zero/multiple candidates.
2. Block send when a visible generation-stop control exists. Resolution and click occur atomically within a WebContents evaluation. Missing controls can be polled briefly; no repeated click after a possible effect.
3. Resolve a unique visible, editable composer by strong accessibility aliases or one unambiguous fallback. Never silently pick an arbitrary contenteditable; fail if an unrelated draft is present in a new session.
4. Update Agent Session delivery proof to support modern `data-user-message-bubble` turns and the observed bounded `Você disse:` accessible heading fallback, while preserving legacy author-role support.
5. Never use `document.body.innerText` as proof of delivery. The proof still requires an actual user turn containing marker+session ID, cleared composer and a `/c/<conversation-id>` URL.
6. Preserve explicit failure and no authority escalation when selectors drift; no credentials, cookies, login bypass, production activation, or new MCF runtime.

## Qualification

- `npm test`: 122/122 passed, 0 failed on source checkout.
- New tests cover delayed send control, ambiguity, active generation-stop state, uncertain render outcome, modern editor, multiple editors, modern user turn, heading fallback, and draft-only rejection.
- **Live v0.7.5 build/install smoke remains pending.** Deployed/notebook app is v0.7.4 and was not touched.
- Agent Session task/response route and canonical MCF MissionRuntime receipt remain follow-up work; this change repairs UI semantics and bootstrap proof only.

## Governance

LEANDRO requested continued correction. MESTRE coordinated an isolated branch. Merge, production deployment and forced reconciliation remain unapproved. Independent review and release qualification are required before promotion.
