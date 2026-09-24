# MCF Dual Browser Cockpit

Execution Surface desktop do ecossistema **MCF — Multiagent Collaboration Framework**.

O Cockpit mantém dois contextos isolados em uma única janela:

- **LEANDRO / ChatGPT** — sessão persistente do usuário;
- **MESTRE · WORKSPACE** — Chromium/WebContentsView operacional para navegação e artefatos.

## Estado deste repositório

Este repositório contém o código-fonte publicável do protótipo local atualmente validado no Linux.  
O repositório canônico de governança do MCF continua sendo:

https://github.com/leon337/multiagent-collaboration-framework

O Cockpit é uma **Execution Surface**; ele não substitui o Mission Runtime ou a governança do MCF.

## Capacidades atuais

- Electron 44 + WebContentsView;
- partitions persistentes e isoladas;
- restauração de URLs, janela e split;
- Agent Bridge local em loopback com token efêmero;
- navegação programática multipainel para `chat` (EMILLY) e `workspace` (SOPHIA);
- leitura de estado, texto e elementos interativos por pane;
- ações `navigate`, `action`, `find-click`, `click`, `type`, `pointer`, `upload-file` e `capture` endereçáveis por pane;
- ação semântica `/v1/find-click`, inclusive em frames, sem exportar o DOM inteiro;
- captura por pane; o Workspace mantém o capturador nativo compartilhado e o Chat usa captura direta do WebContents;
- integração com ORCA/AT-SPI para observação semântica;
- áudio via PipeWire/PulseAudio em Linux;
- AppImage Linux e targets Windows via electron-builder.

## Segurança

O repositório **não contém** cookies, sessões, tokens de usuário ou credenciais locais.

O Agent Bridge:

- escuta apenas em `127.0.0.1`;
- usa token aleatório por execução;
- não deve ser exposto diretamente à rede;
- deve preferir ações semânticas/programáticas (`find-click`, `click`, `type`, `navigate`) a coordenadas físicas;
- `/v1/pointer` permanece compatível, mas não é o caminho autorizado do MESTRE quando existe alternativa semântica;
- deve permanecer sujeito à governança e aos gates do MCF.

## Desenvolvimento

```bash
npm install
npm run check
npm start
```

Build Linux:

```bash
npm run dist:linux
```

Build Windows:

```bash
npm run dist:win
```

## Relação com o MCF

```text
MCF Mission Runtime / governança
            |
            v
MCF Dual Browser Cockpit
            |
            v
Workspace / artefatos / navegação programática
```

## Licença

MIT.

## Versão 0.3.0

Consulte [instâncias e pausa](docs/INSTANCIAS.md), [auditoria](docs/missions/MCF-DUAL-AUDIT-20260922/AUDIT.md) e [validação](docs/missions/MCF-DUAL-AUDIT-20260922/VALIDATION.md). A Bridge inicia ligada, autenticada e limitada a loopback.


## Agent Bridge multipainel

Rotas de leitura aceitam o pane por query string:

    GET /v1/state?pane=chat
    GET /v1/text?pane=workspace
    GET /v1/interactive?pane=chat

Rotas de ação aceitam o pane no JSON:

    {"pane":"chat", ...}
    {"pane":"workspace", ...}

Aliases aceitos:
- `chat`, `emilly`, `emily` -> painel EMILLY;
- `workspace`, `sophia`, `sofia` -> painel SOPHIA.

Quando `pane` é omitido, a Bridge preserva compatibilidade e usa `workspace`.

Exemplos:

    POST /v1/navigate
    {"pane":"chat","url":"https://example.com"}

    POST /v1/action
    {"pane":"workspace","action":"reload"}

    POST /v1/click
    {"pane":"chat","selector":"button[type=submit]"}

    POST /v1/type
    {"pane":"workspace","selector":"textarea","text":"texto"}

A rota `/v1/pointer` também é multipainel, mas ações semânticas/programáticas continuam preferidas quando disponíveis.
