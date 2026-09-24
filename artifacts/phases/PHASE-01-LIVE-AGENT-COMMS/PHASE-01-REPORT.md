# PHASE-01 — Execution Report

## Mission
MCF-LIVE-AGENT-COMMS-001 — Class C
Authority: LEANDRO · Orchestrator: MESTRE
MCF Issue: #360 · Cockpit PR: #8

## Parallel agents
| Agent | Contribution mission | Final result |
|---|---|---|
| Sofia | MCF-LIVE-AGENT-COMMS-001-SOFIA-ARCH-R1 | COMPLETED 1f526577… |
| Emily | MCF-LIVE-AGENT-COMMS-001-EMILY-AUDIT-R1 | COMPLETED b5e20176… |
| Patrícia | MCF-LIVE-AGENT-COMMS-001-PATRICIA-DEBUG-R1 | COMPLETED 0bc007f3… |
| Rafael | MCF-LIVE-AGENT-COMMS-001-RAFAEL-ENG-R1 | COMPLETED 5620e270… |

MESTRE implemented in parallel and incorporated all four findings.

## Delivered architecture
- PaneAgentRuntime remains the lifecycle authority.
- Instance-local LiveAgentEventBus provides semantic events, bounded replay and bootId:sequence cursors.
- GET /v1/live/snapshot and GET /v1/live/stream are authenticated, read-only and require exact X-MCF-Instance.
- Host, Origin and Bearer boundaries remain fail-closed.
- Persist-before-publish is preserved.
- RESULT_CAPTURED exposes IDs/hash but not result text.
- COMPLETED exposes verified result text only after persisted read-back.
- Conversation change or persistent anchor loss becomes UNVERIFIED and releases the pane queue.
- A later user turn cannot let an unrelated generation control keep an earlier final response non-terminal.

## Qualified executable
Version: 0.6.0
Release code SHA: c11e3984fc76a19780593d35eaabc7f903193322
GitHub Checks #77 / 35995227792: SUCCESS
npm run check: PASS
npm test: 55/55 PASS
git diff --check: PASS
AppImage SHA-256: ee72e8c1505cc0e69dd4eb7738f1909b0412df01b9621f450fd154daa70e7951

## Production
Both local production instances run the exact AppImage:
- notebook / audit-architecture
- notebook-team2 / debug-engineering

A same-version artifact mismatch was detected before final smoke and replaced atomically by the exact qualified AppImage. The replaced image is rollback-only.

## Exact four-agent smoke
Parent: MCF-LIVE-AGENT-COMMS-001-LIVE-SMOKE-R1.

- Emily: COMPLETED da133c46…
- Sofia: COMPLETED 18bef276…
- Patrícia: COMPLETED 589cd31a…
- Rafael: COMPLETED e3d8d890…

Each instance: required=2, completed=2, active=0, closable=true.

## Replay/reconnect
A real team2 stream was opened and deliberately disconnected at cursor 25dfbc01…:65. Rafael executed a replay probe while the consumer was offline. Reconnect returned replayCount=15 and replayed the probe through WORKING → RESULT_CAPTURED → COMPLETED, preserving body gating.

## Visual evidence
Four exact native pane captures are versioned under visual/ and hashed in PHASE-01-SMOKE.txt.

## Audit lineage
R1: FAIL with 0 Critical and 1 High limited to stale closeout documentation; no functional Critical/High identified.
R2: PASS for the documentation remediation, but superseded as final gate after the exact AppImage correction.

## Current gate
The PRF now records only the exact active production artifact. Final gate: Emily R3 against the current PR head, current CI, release code SHA c11e3984fc76a19780593d35eaabc7f903193322, AppImage ee72e8c1505cc0e69dd4eb7738f1909b0412df01b9621f450fd154daa70e7951, exact smoke and replay evidence.
