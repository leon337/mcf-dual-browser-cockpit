# PHASE-01 Decisions

1. LEANDRO authorized continuous implementation, finalization and local production deployment for this mission.
2. Baseline: Cockpit PR #7 head 6fcc47c4b64f6f5d8b93f09b96d8f98947c9fdb8. PR #6 remains outside this merge boundary.
3. Sofia: runtime remains authoritative; persist-before-publish; replay uses a boot epoch.
4. Emily: no live terminal claim during active generation; gaps explicit; four-agent smoke required.
5. Patrícia: navigation/DOM anchor loss can livelock a pane and must be bounded; later-turn generation must not block an earlier terminal answer.
6. Rafael: semantic journal sits between runtime and transport; subscriber failure must never alter lifecycle.
7. MESTRE implemented instance-local bootId:sequence journal, bounded replay, exact instance header and read-only SSE.
8. RESULT_CAPTURED carries no result body; COMPLETED exposes body only after read-back integrity.
9. Conversation change or persistent anchor loss becomes UNVERIFIED and releases the pane queue.
10. Release source SHA fixed at c11e3984fc76a19780593d35eaabc7f903193322.
11. Supported Node 22.23.2 qualification produced 55/55 PASS and AppImage SHA-256 07293708ed3a8ac8aa6d21cb9d6a3813db6015737ee252772edda8a0678dedce.
12. Both local instances were promoted to 0.6.0 and four-agent smoke passed.
13. Replay from team2 cursor :64 recovered 7 events including WORKING/RESULT_CAPTURED/COMPLETED.
14. Emily R1 audit completed with zero Critical and one High only because PRF/PR metadata still described completed gates as outstanding.
15. MESTRE accepted PRF-CLOSEOUT-0.6.0-001 and remediated only documentation/metadata; executable release was not changed.
16. Final gate after this remediation is an independent Emily post-remediation re-audit.
