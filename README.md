# MCF Dual Browser Cockpit

Aplicação desktop para manter **duas superfícies de navegação independentes** na mesma janela:

- **LEANDRO / ChatGPT** à esquerda — sessão persistente própria;
- **MESTRE / Workspace** à direita — navegador operacional isolado;
- divisor redimensionável e presets 65/35, 50/50 e 35/65;
- histórico, voltar/avançar, recarregar, DevTools e abertura externa por painel;
- downloads separados;
- captura da área operacional;
- **Agent Bridge local opcional**, desligado por padrão, para um runtime autorizado controlar somente o navegador da direita.

## Por que esta arquitetura

O app usa **Electron 44.2.0 + Chromium 152 + `WebContentsView`**. Não usa `BrowserView` (obsoleto) nem a tag `<webview>` antiga. A casca do cockpit é HTML/CSS/JavaScript nativo para reduzir dependências e tempo de inicialização.

Não tentamos encaixar o executável inteiro do Brave ou Firefox dentro da janela. Electron já entrega um Chromium embutido e controlável por processo. Isso permite isolamento de sessão e automação de forma muito mais previsível.

## MVP implementado

```text
BrowserWindow (casca do cockpit)
│
├── WebContentsView: persist:mcf-chatgpt
│   └── https://chatgpt.com/
│
├── WebContentsView: persist:mcf-workspace
│   └── navegador operacional
│
├── IPC mínimo e tipado por superfície
│   ├── layout
│   ├── navegação
│   ├── captura
│   └── Agent Bridge
│
└── LocalAgentBridge [OFF por padrão]
    ├── 127.0.0.1 somente
    ├── token aleatório por execução
    ├── sem CORS de páginas web
    └── sem endpoint de JavaScript arbitrário
```

## Requisitos

- Windows 10/11 x64 ou Linux x64;
- Node.js 22.12+ para desenvolvimento;
- conexão com a internet para baixar Electron na primeira instalação e para navegar.

## Executar em desenvolvimento

```bash
npm install
npm start
```

## Validar sintaxe

```bash
npm run check
```

## Gerar executável Windows

```bash
npm install
npm run dist:win
```

Os artefatos serão criados em `release/` (instalador NSIS e versão portable x64).

## Gerar AppImage Linux

```bash
npm install
npm run dist:linux
```

## Sessões e dados

O Electron mantém duas partições persistentes separadas:

```text
persist:mcf-chatgpt
persist:mcf-workspace
```

Cookies, cache, storage e sessão do ChatGPT não são compartilhados automaticamente com o Workspace.

Downloads:

```text
Downloads/MCF-ChatGPT/
Downloads/MCF-Workspace/
```

Capturas:

```text
Pictures/MCF-Cockpit-Captures/
```

## Agent Bridge local

O botão `AGENT BRIDGE OFF` liga uma API HTTP **somente em `127.0.0.1`**. Se a porta padrão `47831` estiver ocupada, o app escolhe outra porta local.

Ao ativar, um token aleatório é criado para a execução. Use o botão `⧉` para copiá-lo.

Header obrigatório nas chamadas de controle:

```text
Authorization: Bearer <TOKEN>
```

Endpoints:

| Método | Endpoint | Função |
|---|---|---|
| GET | `/health` | saúde da bridge; sem controle |
| GET | `/v1/state` | URL, título, loading e histórico |
| GET | `/v1/text` | texto visível da página |
| GET | `/v1/interactive` | elementos clicáveis/editáveis + seletores |
| POST | `/v1/navigate` | abre uma URL HTTP(S) |
| POST | `/v1/action` | back, forward, reload ou stop |
| POST | `/v1/click` | clica por seletor CSS |
| POST | `/v1/type` | preenche input/textarea/contenteditable |
| POST | `/v1/pointer` | clique por coordenada no Workspace |
| POST | `/v1/capture` | salva screenshot do Workspace |

Exemplo de navegação:

```bash
curl -X POST http://127.0.0.1:47831/v1/navigate \
  -H "Authorization: Bearer SEU_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

O bridge rejeita requisições que tragam um header `Origin`, reduzindo a possibilidade de uma página web tentar usar a API local.

## Segurança implementada

- `contextIsolation: true`;
- `sandbox: true`;
- `nodeIntegration: false`;
- `webviewTag: false`;
- `webSecurity: true`;
- CSP rígida na casca do cockpit;
- protocolos fora de HTTP(S) saem para o sistema operacional;
- Workspace sem permissões de câmera/microfone/geolocalização por padrão;
- ChatGPT recebe apenas um conjunto restrito de permissões para domínios ChatGPT/OpenAI;
- Agent Bridge fica desligada por padrão, presa ao loopback e protegida por token efêmero;
- nenhum endpoint de avaliação arbitrária de código.

## Limitações atuais

1. **MESTRE ainda precisa de um runtime/connector para chamar a Agent Bridge.** O app cria a superfície e o contrato local, mas uma sessão normal do ChatGPT não ganha acesso mágico ao `127.0.0.1` do computador.
2. Alguns provedores OAuth podem bloquear login em navegadores embutidos. O app permite janelas HTTPS de autenticação, mas políticas externas podem variar.
3. O MVP possui uma aba operacional por lado. Multi-tab real é a evolução natural da V0.3.
4. Iframes cross-origin não podem ser inspecionados pelo endpoint DOM do bridge; clique por coordenadas e captura continuam disponíveis.

## Próxima evolução sugerida

### V0.3

- múltiplas abas reais no Workspace;
- fila de ações e botão de parada do agente;
- Human Gate na própria interface;
- painel de evidências/screenshot antes e depois;
- downloads visíveis;
- bookmarks e histórico persistente;
- adaptador MCP/MCF sobre o `LocalAgentBridge`;
- allowlist/denylist de domínios por missão;
- gravação de receipts das ações do navegador.

### V0.4

- integração com Voice Hub;
- canal de eventos do MCF;
- missão, agente ativo e handoff na barra superior;
- visualização de execução em graph/loop;
- recuperação de sessão e checkpoint.

## Estrutura

```text
mcf-dual-browser-cockpit/
├── package.json
├── README.md
├── LICENSE
└── src/
    ├── main/
    │   ├── main.mjs
    │   └── bridge.mjs
    ├── preload/
    │   └── preload.cjs
    └── renderer/
        ├── index.html
        ├── styles.css
        └── renderer.js
```

## Observação MCF

Este projeto é um **cockpit/Execution Surface**, não uma nova fonte de verdade do MCF. A integração futura deve consumir contratos do runtime e registrar evidências/receipts sem duplicar a governança canônica.


## Streaming de eventos em tempo real

A Agent Bridge oferece um canal Server-Sent Events (SSE) autenticado e mantido aberto, com replay por cursor e heartbeat:

- `GET /v1/live/stream` (alias: `/v1/events`): conexão SSE persistente; exige `Authorization: Bearer <token>`, `X-MCF-Instance: <instanceId>` e `Accept: text/event-stream`.
- `GET /v1/live/snapshot?after=<bootId:sequence>` (alias: `/v1/events/snapshot`): recupera eventos perdidos usando cursor.
- Eventos de navegação: `NAVIGATION_STARTED`, `NAVIGATION_FINISHED`, `NAVIGATED`, `IN_PAGE_NAVIGATION`, `PAGE_TITLE_UPDATED`, `NAVIGATION_FAILED` e `RENDERER_CRASHED`, além dos eventos de estado e do runtime de agentes.
- A URL publicada nos novos eventos remove query strings e fragmentos para reduzir exposição acidental de parâmetros sensíveis.
- O canal é limitado a loopback e requer token efêmero; não exponha a porta à rede pública.