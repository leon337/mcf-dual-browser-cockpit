# Cockpit 0.7.5 — evidências de inventário e descoberta atômica

Data: 2026-11-01. Repositório próprio: `leon337/mcf-dual-browser-cockpit`.

## Escopo

Descoberta **read-only** de controles nativos do cockpit, canais IPC e rotas HTTP sem criar execução genérica. Inclui correção previamente homologada de verificação de envio do ChatGPT 2026 (balões `data-user-message-bubble`; prova de mensagem exata, progresso, conversa vinculada e composer limpo).

## Evidência de cobertura

- Inventário auditável: **40 controles reais na UI**, **17 IPC**, **35 endpoints HTTP**, total **92 mecanismos**. O divisor `#stageDivider` é visual, não acionável; somente `#toolbarSplitter` recebe eventos de arraste.
- Teste `control-catalog.test.mjs` compara todas as tags interativas HTML e o divisor acionável contra os seletores do catálogo, todas as chamadas IPC expostas contra handlers confiáveis, e todas as rotas declaradas no Bridge contra o catálogo. Falha se houver uma nova função sem inventário.
- Validação negativa: payload sem credenciais mesmo quando Bridge original possui token; nenhuma execução genérica HTTP/IPC.
- Regressão de código Node: `node --test --test-concurrency=2 test/*.test.mjs` **111/111 PASS**, sem falhas, executado no notebook com `umask 077`.
- E2E nativo em **Electron + Xvfb**, HOME e XDG_CONFIG_HOME descartáveis: `python3 test/electron-control-catalog-smoke.py` **PASS**.
- E2E verificou: UI `CONTROLE -> Mecanismos`, todas as 92 linhas listadas; IPC protegido; presets de layout; cópia de catálogo sem credencial; resposta 401 a GET sem bearer e 200 com bearer; GET do catálogo continua 200 quando PAUSED; retoma e CLI live funciona. Limpeza do grupo isolado de processos ao final.
- ChatGPT fora do E2E isolado: dois envios reais da versão 0.7.5 corrigida previamente verificados, com novos balões de usuário e respostas `RECEBIDO-SENDFIX-*` (não reenviados nesta missão).

## Limites de prova

A cobertura de inventário é **exata quanto às superfícies declaradas**, não equivale a prova de que todos os 40 botões foram clicados em produção. Controles com riscos (navegação externa, DevTools, token, uploads, missão, captura) foram mapeados e cobertos por contratos de código, mas não acionados automaticamente. UI e IPC não são invocáveis pela Bridge como uma operação genérica; a casca exige renderer confiável. Duas panes reais não implicam identidades canônicas READY, broker disponível ou MCF Mesh aprovado. TRI 0.8.0 não é reintroduzido.

## Regressão e rollback

Implementar release **paralela** 0.7.5, manter launcher 0.7.5-sendfix, snapshot completo anterior de cookies, e script de reversão a versão 0.7.5-sendfix. Não copiar `node_modules`, cookies ou descritor bearer para Git. Promover somente após E2E isolado e revalidação de duas conversas no perfil existente.
