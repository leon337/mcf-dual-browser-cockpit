# PHASE-01 Decisions

1. LEANDRO authorized continuous implementation, finalization and local production deployment for this mission.
2. Baseline is PR #7 head 6fcc47c4…; PR #6 remains outside this merge decision.
3. Sofia required runtime authority, persist-before-publish and a boot epoch for replay.
4. Emily required no terminal claim during active generation, explicit replay gaps and a four-agent real smoke.
5. Patrícia required bounded conversation/DOM anchor loss and release of same-pane queues.
6. Rafael required a semantic journal between runtime/WebContents and SSE.
7. MESTRE implemented instance-local bootId:sequence replay, exact instance header, heartbeat and read-only SSE.
8. RESULT_CAPTURED carries no result body; COMPLETED carries body only after read-back integrity.
9. Executable release code SHA is c11e3984fc76a19780593d35eaabc7f903193322.
10. A same-version AppImage mismatch was detected during promotion and rejected as final evidence.
11. Exact AppImage ee72e8c1505cc0e69dd4eb7738f1909b0412df01b9621f450fd154daa70e7951 was promoted atomically to notebook and notebook-team2; the prior image remains rollback-only.
12. Exact four-agent smoke parent MCF-LIVE-AGENT-COMMS-001-LIVE-SMOKE-R1 closed 2/2 on each instance.
13. Deliberate disconnect/reconnect from team2 cursor ...:65 replayed 15 events and recovered a Rafael probe through WORKING, RESULT_CAPTURED and COMPLETED without redispatch.
14. Emily R1 found no functional Critical/High; its single High concerned stale closeout documentation.
15. The documentation finding was remediated.
16. Emily R2 returned PASS on that remediation, but it is retained only as lineage because the production AppImage was subsequently corrected to the exact candidate.
17. Final gate is Emily R3 against the current PRF, release code SHA c11e3984fc76a19780593d35eaabc7f903193322, exact AppImage ee72e8c1505cc0e69dd4eb7738f1909b0412df01b9621f450fd154daa70e7951, current PR head and current CI.
