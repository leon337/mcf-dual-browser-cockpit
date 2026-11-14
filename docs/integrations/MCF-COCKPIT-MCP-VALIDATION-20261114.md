# Integração MCP stdio ↔ LocalAgentBridge — Auditoria de 14/11/2026

**Missão:** MCF-COCKPIT-MCP-VALIDATION-20261114
**Fonte do código:** `mcf-cockpit-mcp.mjs`, arquivo recebido via Google Drive do Gemini.
**Fonte de verdade:** `src/main/bridge.mjs` do repositório `leon337/mcf-dual-browser-cockpit`.
**Escopo:** branch Git isolada; sem alterar a instalação Electron em execução e sem merge/deploy.

## Arquitetura

```text
Cliente MCP local (stdio/JSON-RPC 2.0)
   → bin/mcf-cockpit-mcp.mjs [read-only padrão]
   → HTTP loopback + Authorization: Bearer <token>
   → src/main/bridge.mjs (LocalAgentBridge)
   → WebContents Electron (chat/workspace)
```

O MCP usa somente APIs nativas do Node.js 22.12+ e recebe o token por variável de ambiente, não por arquivo versionado.

## Mapeamento auditado

| Tool | HTTP | Rota | Política |
|---|---|---|---|
| cockpit_health | GET | /health | Leitura |
| cockpit_state | GET | /v1/state | Leitura |
| cockpit_accessibility | GET | /v1/accessibility | Leitura |
| cockpit_interactive | GET | /v1/interactive | Leitura |
| cockpit_text | GET | /v1/text | Leitura |
| cockpit_navigate | POST | /v1/navigate | Interativo |
| cockpit_action | POST | /v1/action | Interativo |
| cockpit_click | POST | /v1/click | Interativo |
| cockpit_find_click | POST | /v1/find-click | Interativo |
| cockpit_type | POST | /v1/type | Interativo |
| cockpit_pointer | POST | /v1/pointer | Interativo |
| cockpit_capture | POST | /v1/capture | Interativo |

Todas as rotas aparecem no `bridge.mjs`. Os payloads e headers foram validados por servidor de testes simulado.

## Segurança e execução

- `MCF_MCP_MODE=read-only` é padrão: anuncia 5 ferramentas e recusa mutações mesmo chamadas diretamente.
- `MCF_MCP_MODE=interactive` libera as 12 ferramentas **somente mediante autorização/governança externa**. Esta flag não substitui HUMAN_GATE, permission engine nem receipts.
- `MCF_BRIDGE_URL` (padrão `http://127.0.0.1:47831`) aceita apenas HTTP loopback; redirecionamentos bloqueados.
- `MCF_BRIDGE_TOKEN` é necessário para `/v1/*`; nunca publicar ou imprimir seu valor.
- `MCF_INSTANCE_ID` é opcional; vincula chamadas a uma instância específica.
- Timeout de 15 s e verificação de schema, pane, URLs, tamanho de texto, seletor e coordenadas.

**Execução no checkout:** `npm run mcp` ou `node bin/mcf-cockpit-mcp.mjs`, com token já fornecido de forma segura pelo cliente/ambiente.

## Evidência e critérios

1. `node --check` do servidor: PASS.
2. `node --test test/mcf-cockpit-mcp.test.mjs`: 6/6 PASS (initialize, ping, catálogo, mapeamento 12 ferramentas, headers, bloqueios).
3. `npm test` do repositório, após inclusão: 117/117 PASS, exit 0.
4. `GET /health` da Bridge real em `127.0.0.1:47831`: HTTP 200.

**Limite:** o 4/4 é integração MCP→Bridge **simulada**; a Bridge real só recebeu leitura de saúde não autenticada. Não foi executado clique, digitação, navegação, captura ou GET autenticado em sessão real; portanto não há certificação E2E de uma sessão autenticada real.

O pacote Electron atual inclui `src/**/*`, não `bin/**/*`; a integração existe no checkout, não no AppImage empacotado. Não há conexão ao dispatcher/permission engine do runtime central MCF, nem configuração automática de cliente MCP.

**Para promover:** validar com sessão autenticada de teste, integrar gates e receipts do MCF, revisar segurança e CI, aprovar alteração e somente então planejar merge/deploy separados.

**Compatibilidade de versões:** a cópia operacional observada é AppImage 0.7.4 e o repositório Git testado declara 0.7.5. As rotas também foram encontradas em arquivo de Bridge no diretório de instalação, mas isso não prova equivalência de toda a implementação empacotada.
