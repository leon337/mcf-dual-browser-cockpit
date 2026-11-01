# Dual Browser 0.7.5 — Inventário verificável e descoberta atômica

> Fonte de verdade de catálogo: [`capabilities/control-catalog.v1.json`](../capabilities/control-catalog.v1.json). A leitura LIVE usa o processo ativo, não o JSON isolado.

## Descoberta em um comando

Na máquina que executa o Cockpit:

```bash
mcf-cockpit-discover --instance=notebook --summary
```

Se o atalho não estiver instalado, use `node bin/mcf-cockpit-discover.mjs --instance=notebook` a partir da raiz deste repositório ou do pacote release. Para somente contrato estático, utilize `--offline`.

**Contrato autenticado:** `GET http://127.0.0.1:<port>/v1/control-catalog`, com cabeçalhos `Authorization: Bearer <token>` e `X-MCF-Instance: notebook`, lidos *internamente* do descritor privado em `~/.config/mcf-dual-browser-cockpit/instances/notebook/agent-bridge.json`. Não copie/registre o token em relatórios ou chats. **A rota é somente leitura**, inclusive quando PAUSED; não executa controles nem fornece endpoint genérico de IPC.

**Descoberta complementar:** `GET /v1/discovery` fornece instância, panes, identidades, missões e warnings runtime. `GET /v1/control-catalog` fornece o contrato de capacidades. As duas respostas não equivalem a autorização para enviar.

## Interface visual

Cada item abaixo inclui o seletor de shell exato. Para acionar controles da casca, use o próprio clique humano ou automação autorizada na **janela Electron da casca**, não nos WebContents do ChatGPT. O catálogo não cria interface de `eval`, `ipcRenderer` arbitrário ou bypass de gates.

| Controle (seletor) | Ação / IPC | Risco |
|---|---|---|
| `[data-preset="leandro"]` | `layout.preset` / `layout:preset` | `changes-layout` |
| `[data-preset="balanced"]` | `layout.preset` / `layout:preset` | `changes-layout` |
| `[data-preset="mestre"]` | `layout.preset` / `layout:preset` | `changes-layout` |
| `#controlCenterButton` | `open/closeControlCenter` / `layout:set-mode` | `changes-layout` |
| `#bridgeButton` | `bridge.toggle` / `bridge:toggle` | `changes-bridge-state` |
| `#pauseBridgeButton` | `bridge.pause` / `bridge:pause` | `changes-pause-state` |
| `#copyTokenButton` | `bridge.copyToken` / `bridge:copy-token` | `credential-to-clipboard` |
| `[data-pane="chat"][data-action="back"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="chat"][data-action="forward"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="chat"][data-action="reload"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="chat"][data-action="home"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="chat"][data-action="devtools"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-external="chat"]` | `browser.openExternal` / `browser:open-external` | `external-navigation` |
| `#toolbarSplitter` | `layout.setSplit / local pointer` / `layout:set-split` | `changes-layout` |
| `[data-pane="workspace"][data-action="back"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="workspace"][data-action="forward"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="workspace"][data-action="reload"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-pane="workspace"][data-action="home"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `#workspaceAddress` | `browser.navigate` / `browser:navigate` | `external-navigation` |
| `#goButton` | `browser.navigate` / `browser:navigate` | `external-navigation` |
| `#captureButton` | `workspace.capture` / `workspace:capture` | `writes-screenshot` |
| `[data-pane="workspace"][data-action="devtools"]` | `browser.action` / `browser:action` | `mutates-browser` |
| `[data-external="workspace"]` | `browser.openExternal` / `browser:open-external` | `external-navigation` |
| `[data-control-tab="overview"]` | `switchControlPage` / `local` | `changes-ui-only` |
| `[data-control-tab="observability"]` | `switchControlPage` / `local` | `changes-ui-only` |
| `[data-control-tab="settings"]` | `switchControlPage` / `local` | `changes-ui-only` |
| `#refreshControlButton` | `refreshControlSnapshot` / `bridge:get-observability` | `read-only` |
| `#closeControlCenter` | `closeControlCenter` / `layout:set-mode` | `changes-layout` |
| `[data-open-tab="observability"]` | `switchControlPage` / `local` | `changes-ui-only` |
| `#settingsForm` | `settings.save` / `settings:save` | `writes-settings` |
| `#settingsAutomationToggle` | `bridge.pause` / `bridge:pause` | `changes-pause-state` |
| `#settingsStartBridge` | `settings.save via form` / `settings:save` | `writes-settings` |
| `#settingsPort` | `settings.save via form` / `settings:save` | `writes-settings` |
| `#settingsLayout` | `settings.save via form` / `settings:save` | `writes-settings` |
| `#settingsRefresh` | `settings.save via form` / `settings:save` | `writes-settings` |
| `#settingsEventLimit` | `settings.save via form` / `settings:save` | `writes-settings` |
| `#saveSettingsButton` | `settings.save` / `settings:save` | `writes-settings` |
| `[data-control-tab="capabilities"]` | `switchControlPage` / `local` | `changes-ui-only` |
| `#catalogRefresh` | `discovery.getCatalog` / `control:catalog` | `read-only` |
| `#catalogCopy` | `discovery.copyCatalog` / `control:copy-catalog` | `clipboard-sanitized` |

## IPC do Electron

IPC é **restrito ao `mainWindow.webContents` e ao frame principal**. Não existe endpoint HTTP para invocar IPC arbitrário.

| Canal | Classificação |
|---|---|
| `bridge:copy-token` | `side-effect` |
| `bridge:get-observability` | `read-only` |
| `bridge:get-state` | `read-only` |
| `bridge:pause` | `side-effect` |
| `bridge:toggle` | `side-effect` |
| `browser:action` | `side-effect` |
| `browser:get-states` | `read-only` |
| `browser:navigate` | `side-effect` |
| `browser:open-external` | `side-effect` |
| `layout:preset` | `side-effect` |
| `layout:set-mode` | `side-effect` |
| `layout:set-split` | `side-effect` |
| `settings:get` | `read-only` |
| `settings:save` | `side-effect` |
| `workspace:capture` | `side-effect` |
| `control:catalog` | `read-only` |
| `control:copy-catalog` | `clipboard-sanitized` |

## API HTTP autenticada

Uma rota POST **não é promessa de execução**, e endpoints condicionais podem responder indisponíveis por broker ausente, identidade UNBOUND, falta de permissão ou estado de recuperação.

| Método / endpoint | Efeito | Autenticação |
|---|---|---|
| `GET /health` | `read` | `none` |
| `GET /v1/accessibility` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/action` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/agent-receipts` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/agent-session/open` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/agent-sessions` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/agents` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/agents/bootstrap` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/atspi` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/capture` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/click` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/discovery` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/events` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/events/snapshot` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/find-click` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/interactive` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/live/snapshot` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/live/stream` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/message` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/messages/broadcast` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/mission-cancel` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/mission-envelope` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/mission-reconcile` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/mission-result` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/mission-status` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/missions` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/navigate` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/parent-mission-status` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/pointer` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/recovery-checkpoint` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/state` | `read` | `ephemeral bearer token + instance header` |
| `GET /v1/text` | `read` | `ephemeral bearer token + instance header` |
| `POST /v1/type` | `mutation` | `ephemeral bearer token + instance header` |
| `POST /v1/upload-file` | `mutation` | `ephemeral bearer token + instance header` |
| `GET /v1/control-catalog` | `read` | `ephemeral bearer token + instance header` |

## Operação e verificação

1. `mcf-cockpit-discover --instance=notebook --summary`: identifica versão, quantidade, estado de Bridge e panes, sem tokens.
2. `mcf-cockpit-discover --instance=notebook`: obtém catálogo completo em JSON para outro chat/agente.
3. `node bin/mcf-cockpit-discover.mjs --offline`: fallback mesmo sem Bridge (sem estado live).
4. Em **CONTROLE → Mecanismos**, consulte o catálogo e use **Copiar catálogo JSON** (somente campos sanitizados).
5. Para ações: respeite o campo `channel`, `risk`, `authorization`, o estado `runtime.bridge` e as condições específicas do endpoint. Confirme efeitos por readback; nunca equipare clique, rascunho ou HTTP 200 à execução de missão canônica.

## Critérios de regressão / rastreabilidade

- `test/control-catalog.test.mjs` rejeita controles HTML, canais IPC ou rotas HTTP sem entrada no catálogo; verifica a ausência de token e execução genérica.
- Testes HTTP existentes verificam autenticação, pausa, fila e gates; `test/bridge-modern-dom.test.mjs` verifica recibo sem falso positivo.
- Smoke Electron isolado deve confirmar tab de Mecanismos, campos preenchidos, CLI live e rotas 401/200.
- Ações com efeito externo (DevTools, abrir navegador externo, copiar token, uploads, missões, bootstrap) são inventariadas e cobertas por testes de contrato, não automaticamente executadas durante E2E.

## Limitações operacionais / estados

- `bridge.enabled=false`: consultas remotas indisponíveis; CLI `--offline` mantém inventário estático.
- `bridge.paused=true`: GET permanece para diagnóstico, POST é bloqueado por 423.
- `UNBOUND` ou broker ausente: identidade canônica e missão não ficam qualificadas por simples descoberta.
- O código 0.7.5 atende dois panes. Não restaurar silenciosamente TRI 0.8.0 nem STOP previamente guardado.
- Catálogo é somente leitura; acionamento da casca permanece no IPC nativo com remetente confiável.
- Registros de `agent-bridge.json` são efêmeros. Jamais adicionar credenciais em commits.

## Rollback

O pacote de instalação deve ser mantido em release paralelo e ter backup do launcher e perfil antes de ser ativado. Em 2026-11-01, o rollback anterior da correção de envio era `~/.local/bin/mcf-cockpit-rollback-sendfix-20261101`; uma nova versão exige script de rollback próprio, preservando a instalação anterior.
