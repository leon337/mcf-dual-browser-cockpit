import { conversationIdFromChatUrl } from './startup-policy.mjs';

export const RUNTIME_DISCOVERY_SCHEMA = 'mcf-dual-browser-runtime-discovery/v1';

function normalizeAgentSession(session) {
  const chatUrl = session?.chatUrl ?? null;
  const conversationId = conversationIdFromChatUrl(chatUrl);
  const deliveryVerified = Boolean(
    session?.bootstrapSent
      && conversationId
      && !session?.bootstrapError
  );
  const stateWarning = session?.surfaceState === 'OPEN' && !deliveryVerified
    ? 'open_without_conversation_evidence'
    : null;

  return {
    ...session,
    conversationId,
    deliveryVerified,
    stateWarning,
  };
}

function normalizePaneState(state) {
  const url = state?.url ?? null;
  return {
    pane: state?.pane ?? null,
    url,
    title: state?.title ?? null,
    loading: Boolean(state?.loading),
    conversationId: conversationIdFromChatUrl(url),
  };
}

export function buildRuntimeDiscovery({
  instanceId,
  agentProfile,
  paused = false,
  busy = false,
  queueDepth = 0,
  paneAgents = [],
  paneStates = [],
  agentSessions = [],
  canonicalAgents = [],
  warnings = [],
} = {}) {
  const normalizedPanes = Array.isArray(paneStates)
    ? paneStates.map(normalizePaneState)
    : [];
  const normalizedPaneAgents = Array.isArray(paneAgents) ? paneAgents : [];
  const combinedWarnings = Array.isArray(warnings) ? [...warnings] : [];

  for (const agent of normalizedPaneAgents) {
    const pane = normalizedPanes.find(item => item.pane === agent?.pane);
    if (!pane?.conversationId) continue;
    if (agent?.state === 'READY' && agent?.handshakeVerified === true) continue;
    combinedWarnings.push({
      source: 'paneIdentity',
      warning: 'identity_not_ready_conversation_preserved',
      pane: agent?.pane ?? null,
      agentId: agent?.agentId ?? null,
      state: agent?.state ?? null,
      lastError: agent?.lastError ?? null,
      conversationId: pane.conversationId,
    });
  }

  return {
    schema: RUNTIME_DISCOVERY_SCHEMA,
    authority: {
      human: 'LEANDRO',
      orchestrator: 'MESTRE',
    },
    instance: {
      instanceId: instanceId ?? null,
      agentProfile: agentProfile ?? null,
      paused: Boolean(paused),
      busy: Boolean(busy),
      queueDepth: Number(queueDepth) || 0,
    },
    startupProtocol: [
      'Read /v1/discovery before dispatching work.',
      'Preserve restored /c/<conversation-id> panes; startup must not mutate them automatically.',
      'Use pane agents for the two identity-bound panes of this instance.',
      'When LEANDRO explicitly requests fresh pane chats, prefer POST /v1/agents/bootstrap with force=true and parallel=true.',
      'Use Agent Session only when an independent ChatGPT window/session is required.',
      'Treat composer text as a draft, never as delivery evidence.',
      'Require explicit conversation evidence before declaring a new chat/session open.',
    ],
    mechanisms: {
      paneAgents: {
        purpose: 'Two persistent identity-bound panes per Dual Browser instance.',
        startupPolicy: {
          restoredConversationHasPriority: true,
          autoBootstrapOnRestoredConversation: false,
          explicitBootstrapRoute: 'POST /v1/agents/bootstrap',
          fastFreshBootstrap: {
            route: 'POST /v1/agents/bootstrap',
            body: { force: true, parallel: true },
            requiresExplicitFreshChatIntent: true,
            preservesMissionRecoveryGate: true,
            reconciliationPrecedesResend: true,
            completion: 'all requested pane agents are READY with handshakeVerified=true and canonical /c/<conversation-id> URLs',
          },
        },
        routes: {
          list: 'GET /v1/agents',
          bootstrap: 'POST /v1/agents/bootstrap',
          dispatchMission: 'POST /v1/mission-envelope',
          missions: 'GET /v1/missions',
          missionStatus: 'GET /v1/mission-status?envelopeId=<id>',
          missionResult: 'GET /v1/mission-result?envelopeId=<id>',
        },
        panes: ['chat', 'workspace'],
      },
      agentSessions: {
        purpose: 'Independent BrowserWindow ChatGPT session for any canonical MCF agent.',
        routes: {
          list: 'GET /v1/agent-sessions',
          open: 'POST /v1/agent-session/open',
        },
        creationRule: {
          composerDraftIsDeliveryEvidence: false,
          requiredEvidence: [
            'matching user turn exists outside composer',
            'bootstrap is no longer present in composer',
            'conversation URL has /c/<conversation-id>',
          ],
        },
      },
      liveChannel: {
        purpose: 'Read-only semantic event stream; it does not execute missions or decide terminality.',
        routes: {
          snapshot: 'GET /v1/live/snapshot',
          stream: 'GET /v1/live/stream',
        },
      },
      directPaneAutomation: {
        purpose: 'Semantic/programmatic navigation and interaction inside chat/workspace panes.',
        routes: {
          state: 'GET /v1/state?pane=<chat|workspace>',
          text: 'GET /v1/text?pane=<chat|workspace>',
          interactive: 'GET /v1/interactive?pane=<chat|workspace>',
          navigate: 'POST /v1/navigate',
          message: 'POST /v1/message',
          broadcast: 'POST /v1/messages/broadcast',
          findClick: 'POST /v1/find-click',
          click: 'POST /v1/click',
          type: 'POST /v1/type',
          capture: 'POST /v1/capture',
        },
      },
    },
    correctness: {
      falseGreenAllowed: false,
      conversationCreation: {
        draftOnly: 'NOT_CREATED',
        confirmed: 'matching user turn + cleared bootstrap draft + /c/<conversation-id>',
      },
      restoredConversation: {
        preserveOnStartup: true,
        identityNotReadyDoesNotAuthorizeImplicitBootstrap: true,
      },
    },
    current: {
      panes: normalizedPanes,
      paneAgents: normalizedPaneAgents,
      canonicalAgents: Array.isArray(canonicalAgents) ? canonicalAgents : [],
      agentSessions: Array.isArray(agentSessions)
        ? agentSessions.map(normalizeAgentSession)
        : [],
    },
    warnings: combinedWarnings,
  };
}
