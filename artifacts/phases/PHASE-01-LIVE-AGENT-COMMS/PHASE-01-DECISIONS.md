# PHASE-01 — Decisions

1. LEANDRO authorized continuous implementation, finalization and production deployment for this mission.
2. PR #6 remains outside this mission and must not be merged by inference.
3. Baseline is PR #7 head 6fcc47c4b64f6f5d8b93f09b96d8f98947c9fdb8.
4. Runtime persistence remains the source of truth; SSE is transport/observability only.
5. Live transport is GET-only, authenticated, loopback-only and instance-scoped.
6. Cursor is bootId:sequence; replay gaps are explicit.
7. Heartbeats do not advance the replay cursor.
8. Mission state is persisted before event publication.
9. RESULT_CAPTURED may be observed, but result body is exposed live only at COMPLETED after read-back validation.
10. Conversation change during result observation fails closed as UNVERIFIED and releases the pane queue.
11. A later user turn prevents a global generation control from blocking terminality of an earlier completed assistant turn.
12. MESTRE multiplexes two independent instance streams; no cross-instance broker is introduced.
