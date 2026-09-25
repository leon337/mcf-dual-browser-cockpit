export const RUNTIME_DISCOVERY_SCHEMA = 'mcf-dual-browser-runtime-discovery/v1';

function conversationIdFromUrl(value) {
  try {
    return new URL(String(value || '')).pathname.match(/\/c\/([^/]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeAgentSession(session) {
  const chatUrl = session?.chatUrl ?? null;
  const conversationId = conversationIdFromUrl(chatUrl);
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

export function buildRuntimeDiscovery({
  instanceId,
  agentProfile,
  paused = false,
  busy = false,
  queueDepth = 0,
  paneAgents = [],
  agentSessions = [],
  canonicalAgents = [],
  warnings = [],
} = {}) {
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
      'Use pane agents for the two identity-bound panes of this instance.',
      'Use Agent Session only when an independent ChatGPT window/session is required.',
      'Treat composer text as a draft, never as delivery evidence.',
      'Require explicit conversation evidence before declaring a new chat/session open.',
    ],
    mechanisms: {
      paneAgents: {
        purpose: 'Two persistent identity-bound panes per Dual Browser instance.',
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
    },
    current: {
      paneAgents: Array.isArray(paneAgents) ? paneAgents : [],
      canonicalAgents: Array.isArray(canonicalAgents) ? canonicalAgents : [],
      agentSessions: Array.isArray(agentSessions)
        ? agentSessions.map(normalizeAgentSession)
        : [],
    },
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}
