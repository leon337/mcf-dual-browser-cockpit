# Guia de operação e configurações — MCF Dual Browser Cockpit

**Escopo documental:** interface observada em 12/10/2026, identificada pelo usuário como versão 0.7.4. O snapshot de código extraído em `active-app-inspection` contém metadados de pacote 0.7.1; por isso, a versão exata do código-fonte correspondente ao binário 0.7.4 permanece uma reconciliação pendente. Não tratar esse snapshot como prova de paridade de release.

## 1. Superfícies e controles visíveis

### Barra superior
- **LEANDRO 65% / 50–50 / MESTRE 65%:** presets de largura dos dois painéis.
- **CONTROLE:** abre o painel central.
- **AGENT BRIDGE OFF / AGENT BRIDGE · porta:** ativa/desativa o servidor HTTP local.
- **PAUSAR / RETOMAR:** bloqueia/libera novas ações de automação. Não é uma preferência de Configurações; é um estado operacional.
- **⧉:** copia o token efêmero da bridge ativa. Nunca registrar o token em logs, issues, screenshots compartilhados ou documentação.

### Painel CONTROLE
- **Visão geral:** estado da bridge/runtime, quantidade de agentes e missões, fila, painéis disponíveis e eventos recentes.
- **Observabilidade:** estado da instância/bridge, painéis e suas URLs, identidades/agentes, missões, feed de eventos e receipts resumidos.
- **Configurações:** preferências persistidas descritas abaixo.

### Barra de cada painel
- voltar, avançar, recarregar e home;
- endereço/pesquisa do Workspace e botão IR;
- captura do Workspace;
- DevTools e abertura no navegador padrão.

## 2. Preferências atualmente persistidas no painel

| Preferência | Valores/validação observados | Quando se aplica |
|---|---|---|
| Iniciar Agent Bridge ao abrir | booleano | Próxima inicialização |
| Porta preferencial | inteiro entre 1024 e 65535; porta alternativa pode ser escolhida se ocupada | Próxima ativação |
| Layout padrão | `balanced`, `leandro`, `mestre` | Layout pode aplicar ao salvar; default na abertura |
| Atualização de observabilidade | 2000, 3000, 5000 ou 10000 ms | Imediato enquanto painel estiver aberto |
| Histórico visível | 25, 50 ou 100 registros | Próxima leitura/renderização |

Esses são os cinco campos do schema `mcf-cockpit-control-settings/v1` localizado no snapshot de código inspecionado. Não presumir que eles sejam todas as configurações internas do Electron ou do produto.

## 3. Estado operacional versus configuração persistida

- **Pausar/retomar automação:** estado operacional atual, controlado pela barra superior. A bridge responde HTTP 423 com `automation_paused` para ações POST quando pausada.
- **Bridge ligada/desligada:** estado atual do servidor HTTP. A preferência “iniciar ao abrir” é distinta do estado ligado/desligado agora.
- **Porta ativa:** pode diferir da porta preferencial se a preferida estiver ocupada.
- **Instance ID e perfil de agentes:** metadados da instância. O perfil observado é definido na inicialização; não oferecer edição dinâmica sem implementar e testar um fluxo real.
- **URL, título e loading:** observabilidade da navegação, não preferências.
- **Sessões/cookies/storage:** persistem por partições separadas do Electron; não adicionar botões de limpeza/migração sem confirmação clara, aviso de irreversibilidade e testes.
- **Atualização do aplicativo:** não há, no snapshot observado, controle de atualização automática documentado. Não inventar um toggle sem backend funcional.

## 4. Agent Bridge — operação segura

A bridge deve escutar somente em `127.0.0.1`, exigir `Authorization: Bearer <TOKEN>`, rejeitar chamadas com `Origin` e manter o token efêmero fora de logs. Nunca expor a porta publicamente.

Endpoints observados/documentados:
- `GET /health` — saúde sem controle;
- `GET /v1/state` — URL, título, loading, histórico e estado;
- `GET /v1/text` — texto visível da página;
- `GET /v1/interactive` — elementos interativos;
- `GET /v1/accessibility` — árvore de acessibilidade;
- `POST /v1/navigate`, `/v1/action`, `/v1/click`, `/v1/type`, `/v1/pointer`, `/v1/capture` — ações controladas no Workspace.

Não contornar a pausa por uma rota alternativa. Retomar pelo controle oficial do cockpit e verificar o estado antes de repetir a ação.

## 5. Troubleshooting

### `HTTP 423 automation_paused`
1. Conferir o estado em CONTROLE → Visão geral/Observabilidade.
2. Na barra superior, usar RETOMAR se a pausa for intencionalmente reversível.
3. Confirmar `paused=false` no estado da bridge.
4. Repetir primeiro em `https://example.com/`.
5. Só então navegar para o destino real. Não remover a pausa automaticamente nem criar bypass HTTP.

### Bridge não responde
1. Conferir o indicador de bridge e a porta ativa.
2. Verificar `GET /health` em loopback.
3. Se a porta preferida estiver ocupada, usar a porta ativa mostrada pela UI.
4. Não copiar tokens para logs/issue; obter o token apenas pela interface oficial.

### Configuração salva, mas efeito não aparece
Verificar a indicação de quando a preferência se aplica. Inicialização/porta preferencial são aplicadas na próxima abertura/ativação; intervalo de observabilidade é aplicado ao configurar o timer; layout é aplicado ao salvar.

## 6. Lacunas e critérios de conclusão da reconciliação

- [ ] Identificar o commit/tag exato do código-fonte que corresponde ao binário 0.7.4.
- [ ] Alinhar package version, release notes, README, árvore de arquivos e build reproducível.
- [ ] Criar catálogo único de configurações com categoria, tipo, default, validação, persistência, escopo, risco e momento de aplicação.
- [ ] Incluir estado de pausa/retomada na seção de controle operacional das Configurações, mantendo o comando explícito e sem bypass.
- [ ] Só expor toggles para recursos que já tenham comportamento funcional verificável.
- [ ] Testar defaults, valores inválidos, persistência, pausa/retomada e comportamento de portas ocupadas.
- [ ] Validar interface e build da versão que realmente será distribuída.
- [ ] Atualizar o checklist com saídas verificáveis e link de commit.

## 7. Referências
- Repositório: https://github.com/leon337/mcf-dual-browser-cockpit
- Tarefa do produto: https://github.com/leon337/mcf-dual-browser-cockpit/issues/23
- Tarefa de integração/governança MCF: https://github.com/leon337/multiagent-collaboration-framework/issues/439
- Migração futura para Agent Workspace: https://github.com/leon337/multiagent-collaboration-framework/issues/381


## Atualização 0.7.5 — controle explícito da automação

Na versão seguinte, abra **CONTROLE → Configurações → Controle da automação**. A tela mostra o estado em tempo real e oferece o botão de pausar/retomar. A pausa bloqueia novas ações da bridge; não interrompe uma ação já em curso. Se a bridge estiver desligada, o controle permanece indisponível.
