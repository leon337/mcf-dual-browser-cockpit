# MCF-DUAL-AGENT-IDENTITY-001 — Contrato

## Objetivo

Materializar Emily e Sofia como agentes MCF vinculados aos dois panes permanentes do Dual Browser, consumindo identidade do MCF canônico em vez de tratar nomes de UI como fonte de verdade.

## Bindings

| Pane | Agente canônica | Papel | Contrato |
|---|---|---|---|
| chat | Emily | Auditoria Independente | docs/agentes/EMILY.md |
| workspace | Sofia | Arquitetura de Software | docs/agentes/SOFIA.md |

Aliases visuais legados como EMILLY/SOPHIA não alteram o agentId canônico.

## Invariantes

- LEANDRO continua autoridade humana final.
- MESTRE continua orquestrador.
- identidade é validada por agentId + role + contractRef + contractDigest;
- mismatch canônico falha fechado;
- cada pane tem sessão e trace próprios;
- bootstrap exige marcador MCF_AGENT_READY;
- missão é entregue por mcf-mission-envelope/v1;
- receipts usam mcf-agent-receipt/v1 e ligam sessão, agente e SHA-256 do envelope;
- missões para panes diferentes podem executar em paralelo;
- missões para o mesmo pane são serializadas;
- receipt de QUEUED não é confundido com DELIVERED, ACCEPTED ou COMPLETED;
- nenhuma identidade configurada é usada como prova de independência cognitiva.
