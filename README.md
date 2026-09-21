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
- navegação programática do Workspace;
- captura do WebContents;
- integração com ORCA/AT-SPI para observação semântica;
- áudio via PipeWire/PulseAudio em Linux;
- AppImage Linux e targets Windows via electron-builder.

## Segurança

O repositório **não contém** cookies, sessões, tokens de usuário ou credenciais locais.

O Agent Bridge:

- escuta apenas em `127.0.0.1`;
- usa token aleatório por execução;
- não deve ser exposto diretamente à rede;
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
