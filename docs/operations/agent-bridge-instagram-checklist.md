# Checklist operacional — reconciliação 0.7.4, Configurações e Agent Bridge

## Objetivo
Reconciliar a documentação e o painel de configurações com o código realmente distribuído do MCF Dual Browser Cockpit, validar a bridge e a navegação, e manter alinhamento com o MCF/Agent Workspace.

## Rastreamento
- Issue do produto: https://github.com/leon337/mcf-dual-browser-cockpit/issues/23
- Issue MCF: https://github.com/leon337/multiagent-collaboration-framework/issues/439
- Evolução futura do Agent Workspace: https://github.com/leon337/multiagent-collaboration-framework/issues/381
- Guia de operação/configurações: ../CONFIGURACOES-E-OPERACAO-0.7.4.md

## Checklist de execução
- [x] Confirmar saúde da bridge em `/health`.
- [x] Confirmar que as bridges `44993`, `47831` e `43325` estavam ativas na inspeção.
- [x] Mapear `44993` para a instância Electron `principal`.
- [x] Obter o token somente pela interface oficial; token nunca impresso ou registrado.
- [x] Validar `GET /v1/state`, `/v1/text`, `/v1/interactive` e `/v1/accessibility`.
- [x] Testar `POST /v1/navigate` para `https://example.com/` e registrar o bloqueio.
- [x] Localizar o mecanismo de pausa e o handler confiável `bridge:pause`.
- [x] Inventariar os cinco campos persistidos de configuração e os controles principais.
- [x] Abrir issues de reconciliação no repositório do Cockpit e no MCF.
- [x] Publicar guia operacional inicial com controles conhecidos e lacunas.
- [ ] Reconciliar commit/tag e metadados de release com o binário 0.7.4.
- [ ] Retomar automação somente pelo controle oficial e confirmar `paused=false`.
- [ ] Repetir navegação neutra para `https://example.com/`.
- [ ] Abrir `https://business.facebook.com/` em modo de inspeção; sem publicar, editar ativos ou alterar configurações comerciais.
- [ ] Implementar catálogo de configurações e controles operacionais na fonte de código canônica.
- [ ] Adicionar testes para schema, defaults, validação, persistência, pausa/retomada e regressões.
- [ ] Executar check/test/build e verificar visualmente a UI.
- [ ] Atualizar documentação de release/README/troubleshooting após confirmar paridade de código.
- [ ] Atualizar este checklist com evidências reais e SHAs de commit.
- [ ] Iniciar próxima fase do Agent Workspace preservando Dual Browser como fallback até paridade comprovada.

## Evidências confirmadas
- `GET /health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`, versão da API 1.
- `GET /v1/state`: HTTP 200; inclui URL, título, loading, histórico e estado de automação.
- `GET /v1/text`: HTTP 200.
- `GET /v1/interactive`: HTTP 200; Instagram apresentou 94 nós interativos na inspeção anterior.
- `GET /v1/accessibility`: HTTP 200; árvore retornou 909 nós, 572 não ignorados na inspeção anterior.
- `POST /v1/navigate` para `https://example.com/`: HTTP 423, `automation_paused`; URL/título não mudaram.
- Código inspecionado: `this.paused` é verificado antes de ações POST; `setPaused()` emite evento de pausa/retomada; IPC `bridge:pause` alterna o estado pelo cockpit.
- Configurações persistidas observadas: `startBridgeOnLaunch`, `preferredBridgePort`, `defaultLayout`, `refreshIntervalMs`, `eventLimit`.
- **Limitação importante:** o snapshot `active-app-inspection/package.json` indica versão 0.7.1, enquanto o usuário identifica o binário em uso como 0.7.4. O diretório de instalação local não tem metadados Git; portanto, a fonte canônica e a paridade exata ainda não foram provadas.
- **Não concluído:** navegação Meta Business, alteração do código canônico, testes de regressão e build da versão final.

## Resultado
**PARCIAL — fase de diagnóstico/documentação iniciada.** Issues criadas e guia publicado; implementação e validação de release permanecem pendentes, pois a fonte de código correspondente ao binário 0.7.4 ainda precisa ser identificada.


## Atualização documental e testes adicionais — 12/10/2026
- [x] Publicar o guia operacional inicial: [CONFIGURACOES-E-OPERACAO-0.7.4.md](../CONFIGURACOES-E-OPERACAO-0.7.4.md).
- [x] Reconciliar o README com os controles observados e registrar a ressalva de versão. Commit: `c215429dd8db17f88b4bebb43049e5914c4f800d`.
- [x] Executar `npm run check` e `npm test` no snapshot `active-app-inspection`: **14 testes passaram, 0 falharam**.
- [ ] Não considerar o resultado dos testes como validação do binário 0.7.4: o package do snapshot declara 0.7.1.
- [ ] Implementar alterações no código-fonte canônico, obter build reproduzível e verificar a interface da versão final.
- [ ] Publicar/mesclar o registro MCF via PR [#440](https://github.com/leon337/multiagent-collaboration-framework/pull/440); a branch do MCF preserva a governança de main.
