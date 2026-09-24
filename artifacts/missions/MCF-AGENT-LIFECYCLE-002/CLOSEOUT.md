# Closeout — MCF-AGENT-LIFECYCLE-002

Status: **COMPLETED / evidência operacional validada**

## Objetivo

Tornar o lifecycle de EMILY e SOFIA verificável de ponta a ponta, impedindo que entrega, aceite, geração ou estados transitórios sejam confundidos com conclusão.

Fluxo final:

```text
QUEUED
→ DELIVERED
→ ACCEPTED
→ WORKING
→ RESULT_CAPTURED
→ COMPLETED
```

Estados `FAILED`, `UNVERIFIED` e `INTERRUPTED` permanecem não conclusivos.

## Build final

- Source/package: **0.5.13**
- Branch: `mission/agent-lifecycle-completion-20260924`
- Commit: `c0a0517fa8b78f731c41a8a55c44942a5612156b`
- AppImage SHA-256: `47d76980fc6dfa5c22a3ac2f870d1a5354867f78275053a1e8867cf22b2b7702`
- Instância validada: `notebook`
- `npm run check`: PASS
- `npm test`: **40/40 PASS**
- `git diff --check`: PASS

## Invariantes implementados

1. **DELIVERED exige entrega positiva**: composer/conversa precisam demonstrar avanço real; envio não confirmado falha fechado.
2. **ACCEPTED não é conclusão**: aceite somente inicia o trabalho.
3. **WORKING permanece bloqueante** enquanto a resposta estiver gerando ou mutável.
4. **Placeholder é transitório**: `request-placeholder-*` nunca pode ser resultado terminal.
5. **Migração placeholder → ID final** só é aceita no mesmo turno lógico ancorado pelo `userMessageId` entregue.
6. **Pensando/Thinking não é terminal**.
7. **Interrupção visual é estrutural**: `Raciocínio interrompido`/equivalentes impedem `RESULT_CAPTURED` e `COMPLETED`.
8. **RESULT_CAPTURED exige prova terminal positiva**, identidade da mensagem final, vínculo causal, persistência e SHA-256.
9. **Read-back obrigatório**: o resultado persistido precisa reler com integridade.
10. Para o sinal UI, é exigido `generationActive=false`, `finalActionsObserved=true` e estabilidade mínima de 1200 ms.
11. **Parent mission bloqueia enquanto houver trabalho obrigatório ativo ou sem tentativa COMPLETED válida**.
12. **Retry explícito** preserva idempotência: repetição normal deduplica; `retryFailed=true` cria nova tentativa somente quando o último attempt é terminal não concluído e não existe attempt ativo/COMPLETED.
13. Retries são agrupados pelo mesmo `missionId` lógico: aumentam `attempts`, mas não `required`.
14. Falha de envio limpa apenas resíduos reconhecidos de automação; texto desconhecido do usuário é preservado.

## Falhas reais descobertas durante a missão

### Falso COMPLETED com `Pensando`

Uma execução da SOFIA havia sido marcada `RESULT_CAPTURED → COMPLETED` enquanto a interface mostrava **Raciocínio interrompido**. O resultado capturado era apenas `Pensando`.

A captura de tela fornecida por LEANDRO revelou a divergência entre runtime/DOM e interface visível. A partir desse ponto a metodologia operacional passou a exigir cruzamento entre:

```text
estado interno / receipts
+ DOM / WebContents
+ screenshot da interface visível
```

Esse caso motivou os guards de placeholder/transitório/interrupção e o read-back endurecido.

### Falha de entrega da SOFIA

Na missão `MCF-AGENT-LIFECYCLE-002-SOFIA-CLOSEOUT-0.5.11-A1`, a primeira tentativa terminou em:

```text
FAILED — message_send_unconfirmed
cleanup.ok=true
cleanup.cleaned=true
remainingLength=0
```

Nenhum `DELIVERED` falso foi produzido.

A 0.5.12/0.5.13 adicionou retry explícito da mesma missão lógica. A segunda tentativa recebeu novo `envelopeId`, `attemptNumber=2`, `retryOfEnvelopeId` apontando para a tentativa falha e terminou em `COMPLETED`.

## Prova de retry real

Parent: `MCF-AGENT-LIFECYCLE-002-CLOSEOUT-0.5.11-A1`

Estado após retry:

```json
{
  "required": 2,
  "completed": 2,
  "active": 0,
  "attempts": 3,
  "closable": true,
  "blockers": []
}
```

Histórico físico:

- SOFIA tentativa 1: `FAILED`
- SOFIA tentativa 2: `COMPLETED`
- EMILY: `COMPLETED`

O retry não inflou `required`.

## Smoke final 0.5.13

Parent: `MCF-AGENT-LIFECYCLE-002-FINAL-0.5.13`

Transições observadas:

```text
SOFIA WORKING / EMILY QUEUED
→ SOFIA RESULT_CAPTURED / EMILY QUEUED
→ SOFIA COMPLETED / EMILY QUEUED
→ SOFIA COMPLETED / EMILY WORKING
→ SOFIA COMPLETED / EMILY COMPLETED
```

Estado final:

```json
{
  "required": 2,
  "completed": 2,
  "active": 0,
  "attempts": 2,
  "closable": true,
  "blockers": []
}
```

### SOFIA

- state: `COMPLETED`
- envelope: `0f3cc9d3-3842-4078-82a9-401baf50dd8b`
- placeholder inicial: `request-placeholder-...`
- assistant ID final: `23bc29db-64d8-471a-b5ec-91babc2858b9`
- result SHA-256: `2aaa3111cf5c3b5191912af423c6e0b18c93b141b88d0e46a95b295de30f666d`
- read-back: PASS
- stableForMs: 1330
- finalActionsObserved: true

### EMILY

- state: `COMPLETED`
- envelope: `5c9bca3e-7441-40d9-9697-33a91790109f`
- placeholder inicial: `request-placeholder-...`
- assistant ID final: `a1d9d94e-1919-4c4f-9c65-a0c5e57db9d9`
- result SHA-256: `f4f2f44dcbe195c6c61994c51310615bb8fa0e68fd3299599033b7597b82d3df`
- read-back: PASS
- stableForMs: 1385
- finalActionsObserved: true

## Auditoria independente

EMILY realizou auditoria final do pacote de evidências anterior ao bump de versão e emitiu:

- decisão: **PASS**
- Critical: nenhum
- High: nenhum bloqueador residual

A 0.5.13 contém a consolidação commitada do mesmo mecanismo de retry e passou a suíte completa + smoke operacional próprio.

## Evidências

- `FINAL-EVIDENCE-0.5.13.json`
- `08-final-working-0.5.13.png`
- `09-final-mid-0.5.13.png`
- `10-final-completed-0.5.13.png`
- `11-retry-working-0.5.12.png`
- `12-retry-completed-0.5.12.png`
- `13-emily-final-audit-pass-0.5.12.png`

Capturas anteriores 0.5.9–0.5.11 permanecem no diretório como trilha histórica dos bugs e correções.

## Decisão de closeout

A implementação 0.5.13 satisfaz o lifecycle verificável exigido pela missão. O MESTRE pode marcar a missão técnica como concluída.

**LEANDRO permanece a autoridade humana final do MCF.**
