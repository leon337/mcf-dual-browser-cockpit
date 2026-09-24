# Validação pré-auditoria — MCF-AGENT-LIFECYCLE-002

## Estado do source

- versão: 0.5.11
- branch: mission/agent-lifecycle-completion-20260924
- npm run check: PASS
- npm test: 37/37 PASS
- git diff --check: PASS

## Cobertura relevante

A suíte cobre:

- proibição de ACCEPTED -> COMPLETED;
- parent bloqueado durante WORKING;
- captura terminal com messageId/conversationId/SHA-256;
- corrupção/read-back inválido bloqueando completion;
- restart e recovery verificável;
- recovery sem âncora falhando fechado;
- timeout de recovery limitado;
- concorrência isolada Emily/Sofia;
- placeholder -> ID definitivo no mesmo turno;
- rejeição de resultado vindo de outro turno;
- INTERRUPTED a partir de estado visual de interrupção;
- texto substantivo que apenas discute interrupção sem falso positivo;
- DELIVERED com avanço real de conversa;
- cleanup conservador de draft MCF;
- preservação de texto não reconhecido;
- idempotência de dispatch;
- conflito de reutilização do mesmo missionId.

## Evidência visual usada durante a implementação

A inspeção visual foi promovida a evidência de primeira classe após dois falsos positivos detectados:

1. Sofia havia sido marcada COMPLETED com resultado literal `Pensando`, enquanto a UI mostrava estado interrompido.
2. Uma detecção textual ampla classificou relatórios completos como INTERRUPTED porque os próprios relatórios discutiam a expressão de interrupção.

A correção final usa assinatura estrutural do turno interrompido: turno sem user/assistant e botão/status de interrupção, em vez de busca textual ampla.

## Smoke pré-versionamento

Um smoke real mostrou:

- parent bloqueado durante WORKING;
- migração de placeholder para ID definitivo;
- recuperação após restart com read-back/hash;
- Sofia e Emily terminando em COMPLETED;
- parent ficando closable=true.

Essa prova não encerra a missão porque Emily registrou FAIL DE SUFICIÊNCIA PROBATÓRIA: o source 0.5.x ainda não estava disponível em SHA/branch remoto verificável.

## Próximo gate

Após este source ser commitado/pushado:

1. executar novo smoke em build correspondente ao SHA;
2. capturar screenshots em WORKING e terminal;
3. delegar re-auditoria à Emily apontando para commit/PR remoto;
4. fechar a Issue MCF #351 somente se os requisitos de evidência e lifecycle forem satisfeitos.
