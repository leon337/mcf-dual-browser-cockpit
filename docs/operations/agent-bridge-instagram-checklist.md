# Checklist operacional — Agent Bridge, observabilidade e Meta Business

## Objetivo
Validar a observabilidade da Agent Bridge `44993`, testar navegação para uma URL pública neutra e abrir o Meta Business na instância `principal` para diagnosticar dificuldades de navegação.

## Checklist
- [x] Confirmar saúde da bridge em `/health`.
- [x] Confirmar que as bridges `44993`, `47831` e `43325` estão ativas.
- [x] Mapear `44993` para a instância Electron `principal` (PID 518286).
- [x] Obter o token somente pela interface oficial; token nunca impresso ou registrado.
- [x] Validar `GET /v1/state`, `/v1/text`, `/v1/interactive` e `/v1/accessibility`.
- [x] Testar `POST /v1/navigate` para `https://example.com/` e registrar o bloqueio retornado.
- [x] Localizar no código o bloqueio e o mecanismo local de pausa.
- [x] Inspecionar a implementação existente do painel de configurações.
- [ ] Retomar automação somente pelo controle oficial do cockpit e confirmar estado não pausado.
- [ ] Abrir `https://business.facebook.com/` e inspecionar navegação/autenticação.
- [ ] Ampliar o painel para cobrir configurações do aplicativo, com validação, persistência e indicação de quais exigem reinicialização.
- [ ] Corrigir os obstáculos confirmados, adicionar testes de regressão e validar novamente.

## Evidências de observabilidade
- `GET /health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`, versão 1.
- `GET /v1/state`: HTTP 200; retorna URL, título, loading, histórico e estado de automação.
- `GET /v1/text`: HTTP 200; leitura textual disponível.
- `GET /v1/interactive`: HTTP 200; Instagram apresentou 94 nós interativos.
- `GET /v1/accessibility`: HTTP 200; árvore com 909 nós, 572 não ignorados.
- `POST /v1/navigate` para `https://example.com/`: HTTP 423, `automation_paused`; URL e título permaneceram no Instagram. Repetição confirmou o bloqueio.

## Diagnóstico do bloqueio
- `active-app-inspection/src/main/bridge.mjs`: `this.paused` é inicializado como `false`, alterado por `setPaused(paused)` e verificado antes de operações POST; quando pausado, a bridge retorna HTTP 423.
- `active-app-inspection/src/main/main.mjs`: o controle confiável `bridge:pause` alterna o estado com `bridge.setPaused(!bridge.paused)` e persiste o estado de bridge. O caminho de retomada existente é, portanto, o controle oficial do cockpit, não um endpoint HTTP novo.
- Não desativei a pausa via API nem modifiquei a sessão autenticada. A navegação Meta ainda não foi confirmada.

## Configurações — lacuna identificada
O painel `renderer/index.html` já contém uma seção de configurações, mas atualmente cobre apenas cinco preferências: iniciar a bridge, porta preferencial, layout padrão, intervalo de atualização e limite de eventos. O backend `main/control-settings.mjs` valida/persiste somente esses campos. Isso não é ainda um centro completo de configurações do aplicativo.

Direção recomendada: inventário centralizado de configurações por categoria (instância/bridge, navegação e segurança, layout, observabilidade/logs, armazenamento/sessões, agentes/runtime e atualizações), cada uma com tipo, valor padrão, validação, escopo, persistência e política de aplicação (imediata ou próxima inicialização). Não expor tokens, cookies ou conteúdo de sessões.

## Resultado atual
**PARCIAL** — observabilidade de leitura confirmada; bloqueio localizado no estado de pausa; Meta Business ainda não aberto. O painel de configurações existe, mas sua cobertura é limitada e precisa ser ampliada.
