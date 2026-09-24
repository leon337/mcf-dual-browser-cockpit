# MCF-AGENT-LIFECYCLE-002 — Contrato de lifecycle verificável

## Objetivo

Impedir que MESTRE, o runtime ou a missão-pai tratem `ACCEPTED`, silêncio temporário, placeholder visual ou interrupção como conclusão real de uma missão de agente.

## Máquina de estados

Caminho de sucesso:

`QUEUED -> DELIVERED -> ACCEPTED -> WORKING -> RESULT_CAPTURED -> COMPLETED`

Estados de exceção/recovery:

`INTERRUPTED`, `RECOVERING`, `UNVERIFIED`, `FAILED`, `REJECTED`, `CANCELLED_BY_AUTHORITY`.

`ACCEPTED -> COMPLETED` é uma transição inválida.

## Invariantes

1. DELIVERED exige efeito observável na conversa: composer consumido e criação de novo turno do usuário.
2. O `userMessageId` entregue é a âncora causal do turno.
3. ACCEPTED pertence ao primeiro turno assistant causalmente posterior à mensagem entregue.
4. WORKING permanece bloqueante enquanto houver geração/processamento.
5. `request-placeholder-*` nunca satisfaz gate terminal.
6. Migração placeholder -> ID definitivo só é válida no mesmo turno lógico e mesma âncora de usuário.
7. RESULT_CAPTURED exige ID definitivo, conversationId, conteúdo final, prova terminal positiva e SHA-256.
8. Read-back deve reproduzir identidade do turno e hash antes de COMPLETED.
9. Estado visual real de interrupção produz INTERRUPTED, não COMPLETED.
10. Recovery após restart exige âncora de entrega verificável e é limitado; incerteza termina em UNVERIFIED.
11. A missão-pai só é fechável quando todas as sub-missões required=true estão COMPLETED.
12. Repetição idêntica de missionId+agente+parent é idempotente; reutilização conflitante falha com mission_id_conflict.

## Regra de evidência em três camadas

Em transições críticas, MESTRE cruza:

1. estado persistido e receipts;
2. DOM/WebContents e identificadores de turno;
3. screenshot da interface efetivamente visível ao humano.

Divergência entre essas camadas invalida a conclusão até reconciliação.

## Autoridade

- LEANDRO continua autoridade humana final.
- MESTRE orquestra e não pode fechar prematuramente.
- Sofia permanece responsável por arquitetura, sem assumir auditoria independente.
- Emily permanece auditora independente e não corrige silenciosamente o objeto auditado.
