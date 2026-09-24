# Release notes — 0.4.3

## Agent Identity Runtime

- manifests canônicos para Emily e Sofia;
- binding permanente chat -> Emily e workspace -> Sofia;
- validação live contra agent broker/contract digest do MCF;
- bootstrap de identidade com MCF_AGENT_READY;
- estado persistente por instância;
- endpoints /v1/agents, /v1/agents/bootstrap, /v1/mission-envelope e /v1/agent-receipts;
- Mission Envelope e receipts com SHA-256 estável;
- fila de missão por pane: paralelismo entre Emily/Sofia e serialização dentro do mesmo agente;
- statuses explícitos QUEUED, DELIVERED, ACCEPTED, FAILED e UNVERIFIED;
- retry para falha transitória de restauração de conversa;
- preservação da automação multipainel existente.

## Segurança e governança

- mismatch de identidade/contrato falha fechado;
- autoridade LEANDRO/MESTRE explicitada no envelope;
- Emily não recebe permissão implícita para corrigir o artefato auditado;
- Sofia não recebe autoridade de auditoria independente;
- não há alegação de independência cognitiva baseada apenas em sessão/browser separados.
