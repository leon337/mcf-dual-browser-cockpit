# PHASE-01 — Live Agent Communications

Mission: MCF-LIVE-AGENT-COMMS-001
Class: C
Human authority: LEANDRO
Orchestrator: MESTRE
Issue: MCF #360
Technical baseline: Cockpit PR #7 / 6fcc47c4b64f6f5d8b93f09b96d8f98947c9fdb8

## Objective
Provide a live, authenticated, read-only channel from the two local Cockpit instances to MESTRE so agent lifecycle events and final results can be observed without manual polling of each pane.

## Scope
- instance-local semantic event journal;
- authenticated SSE and snapshot endpoints;
- bounded replay with bootId:sequence;
- heartbeat and disconnect handling;
- mission/result correlation;
- no terminal result body before verified COMPLETED;
- fail-closed conversation/anchor loss;
- cross-instance isolation;
- tests, real four-agent smoke, AppImage and local production deployment.

## Out of scope
- merging PR #6;
- changing MCF authority;
- claiming cognitive independence;
- remote/public exposure of the Bridge;
- browser-token query parameters.

## Selected agents
- Sofia — architecture and stream/replay contract.
- Rafael — engineering integration and backpressure/test plan.
- Patrícia — failure/race analysis.
- Emily — independent audit criteria and final re-audit.
- MESTRE — integration, implementation, validation, release and deployment.

## Acceptance
See Issue #360. Release requires green local checks, green CI, exact release SHA, AppImage SHA-256, two live instances, four-agent SSE smoke, replay evidence, runtime/stream/UI coherence, and Emily final audit without Critical/High blockers.
