# PHASE-01 — LIVE AGENT COMMS

Mission: MCF-LIVE-AGENT-COMMS-001
Class: C
Authority: LEANDRO
Orchestrator: MESTRE
Baseline: PR #7 / 0.5.18 / 6fcc47c4b64f6f5d8b93f09b96d8f98947c9fdb8

## Objective

Materialize a continuous, authenticated and verifiable live channel between MESTRE and the four browser agents without replacing the existing mission lifecycle.

## Scope

- per-instance semantic event journal;
- read-only SSE transport;
- bounded replay with boot-aware cursor;
- heartbeat and disconnect cleanup;
- instance isolation;
- mission/result correlation;
- terminal result exposed only after persisted read-back;
- fail-closed conversation-change handling;
- tests, build, real four-agent smoke, audit and local production deployment.

## Agents

- Sofia — architecture and invariants.
- Rafael — engineering integration and operational design.
- Patrícia — failure/race analysis.
- Emily — independent audit criteria and final re-audit.
- MESTRE — implementation, integration, validation and release.

## Acceptance

- no external polling required to discover agent completion;
- four real agents observed through two instance-local streams;
- replay/reconnect explicit and deduplicable;
- no cross-instance event leakage;
- no false terminal while generation is active;
- conversation change cannot livelock a pane;
- runtime, stream, DOM/WebContents and visual evidence converge;
- check/tests/CI/build green on exact SHA;
- final AppImage deployed to notebook and notebook-team2;
- Emily final audit has no Critical/High blocker.
