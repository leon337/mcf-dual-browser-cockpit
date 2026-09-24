# PHASE-01 Decisions

1. LEANDRO authorized continuous implementation, finalization and production deployment for this mission.
2. Baseline chosen: Cockpit PR #7 head 6fcc47c...; PR #6 remains outside merge boundary.
3. Sofia: SSE must not become a second state machine; persist before publish; replay uses boot epoch.
4. Emily: no live terminal claim while generation active; replay gaps must be explicit; four-agent smoke required.
5. Patrícia: external polling delay alone is not result loss; navigation/DOM anchor loss can create a livelock and must be bounded.
6. Rafael: journal must sit between runtime and transport; subscribers cannot block runtime.
7. MESTRE: use bootId:sequence, bounded journal, exact instance header, read-only SSE, verified result body only at COMPLETED.
8. MESTRE: conversation/anchor loss becomes UNVERIFIED, not infinite WORKING.
