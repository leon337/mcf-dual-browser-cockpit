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


## Agent lifecycle verificável

A Bridge expõe o ciclo de vida das missões dos agentes e não trata aceite como conclusão.

Fluxo esperado:

    QUEUED -> DELIVERED -> ACCEPTED -> WORKING -> RESULT_CAPTURED -> COMPLETED

Estados de falha/interrupção (`FAILED`, `UNVERIFIED`, `INTERRUPTED`) permanecem bloqueantes para o closeout até existir uma tentativa válida concluída ou resolução explicitamente autorizada.

Rotas principais:

    POST /v1/mission-envelope
    GET  /v1/missions
    GET  /v1/mission-status?envelopeId=<id>
    GET  /v1/mission-result?envelopeId=<id>
    GET  /v1/parent-mission-status?missionId=<parentMissionId>

Exemplo de missão:

    POST /v1/mission-envelope
    {
      "agentId": "Sofia",
      "missionId": "MISSION-ARCH-1",
      "parentMissionId": "MISSION-PARENT-1",
      "required": true,
      "objective": "Validar a arquitetura."
    }

### Gate de startup e recovery

A Bridge pode estar ouvindo antes de o bootstrap de identidade e o recovery de missões persistidas terminarem. Durante essa janela, novas missões são recusadas com HTTP `503` e:

    {"ok":false,"error":"agent_runtime_initializing"}

O gate só é aberto depois que `bootstrap + recoverPersistedMissions()` terminam. Isso impede que uma missão seja aceita durante uma inicialização ainda instável e depois seja reinterpretada como trabalho interrompido.

### Retry explícito de tentativa terminal

Chamadas normais continuam idempotentes: repetir a mesma missão lógica (`missionId` + agente + parent + mesmo intent) retorna a execução existente e não envia novamente.

Para refazer uma missão cujo último attempt terminou em `FAILED`, `UNVERIFIED` ou `INTERRUPTED`, use explicitamente:

    {
      "agentId": "Sofia",
      "missionId": "MISSION-ARCH-1",
      "parentMissionId": "MISSION-PARENT-1",
      "objective": "Validar a arquitetura.",
      "retryFailed": true
    }

O retry só cria nova execução quando não existe attempt ativo nem `COMPLETED`. A nova execução recebe novo `envelopeId` e `executionId`, registra `attemptNumber` e `retryOfEnvelopeId`, e continua pertencendo ao mesmo `missionId` lógico.

`parentMissionStatus` agrupa attempts pelo `missionId` lógico. Portanto, um retry aumenta `attempts`, mas não aumenta `required`.

### Critério terminal e evidência visual

`RESULT_CAPTURED` exige identidade de mensagem final, vínculo com o turno entregue, SHA-256, persistência/read-back e prova terminal positiva. Para o sinal UI, o runtime exige geração inativa, ações finais observadas e estabilidade mínima.

Marcadores transitórios como `request-placeholder-*`, `Pensando`/`Thinking` e estados visíveis de interrupção não são resultados terminais.

Em validações operacionais de lifecycle, o MESTRE deve cruzar:

    estado interno / receipts
    + DOM / WebContents
    + screenshot da interface visível

Uma divergência entre essas camadas bloqueia o closeout até ser explicada ou corrigida.


## Canal live MESTRE ↔ agentes — v0.6.0

A Bridge expõe um canal de eventos semânticos **read-only**, autenticado e isolado por instância. O runtime de missões continua sendo a única fonte de verdade; o stream não executa missões nem decide terminalidade.

Rotas:

    GET /v1/live/snapshot
    GET /v1/live/stream

Headers obrigatórios:

    Authorization: Bearer <bridge-token>
    X-MCF-Instance: <instance-id>

O stream também exige:

    Accept: text/event-stream

O token nunca é aceito em query string. Host inválido, Origin de navegador, token ausente/inválido e instância divergente continuam falhando fechados.

### Snapshot

/v1/live/snapshot retorna:

- instanceId e agentProfile;
- bootId;
- highWatermarkEventId;
- buffer replayável recente;
- identidades atuais;
- missões atuais.

Para evitar perda na fronteira snapshot → stream, o consumidor deve guardar highWatermarkEventId e abrir o stream a partir desse cursor. Eventos ocorridos durante a leitura do snapshot podem reaparecer no replay; o consumidor deduplica por eventId.

### SSE e replay

Os IDs têm o formato:

    <bootId>:<sequence>

O buffer é bounded por quantidade, idade e bytes. Heartbeats são comentários SSE e não avançam cursor.

Quando o cursor ainda existe no mesmo boot, somente eventos posteriores são reproduzidos. Se o cursor expirou, é inválido ou pertence a outro boot, o stream emite channel.replay_reset explicitamente. O cliente deve reconciliar por snapshot em vez de presumir continuidade.

Eventos principais:

- BRIDGE_STARTED / BRIDGE_STOPPING;
- PANE_STATE — observacional;
- AGENT_RECEIPT — autoritativo;
- MISSION_STATE — autoritativo, incluindo WORKING, RESULT_CAPTURED, COMPLETED e falhas.

Um evento MISSION_STATE terminal transporta a correlação da missão e, quando disponível, o resultado final com conversationId, assistantMessageId, linkedUserMessageId, resultSha256 e texto bounded.

### Regra terminal

O fluxo continua:

    QUEUED -> DELIVERED -> ACCEPTED -> WORKING -> RESULT_CAPTURED -> COMPLETED

O stream não altera essa máquina. Estado é persistido antes de ser publicado. COMPLETED só aparece depois do read-back e validação de integridade já exigidos pelo lifecycle.

Mudança de conversa durante a observação do resultado falha fechada como UNVERIFIED e libera a fila do pane, evitando WORKING infinito. Uma geração iniciada em turno posterior não mantém artificialmente uma resposta anterior como não-terminal.

### Topologia multi-instância

Cada instância possui seu próprio:

- processo/Bridge;
- token;
- bootId;
- journal;
- ring buffer;
- runtime state.

MESTRE multiplexa os streams de notebook e notebook-team2 no cliente. Não existe broker cross-instance nem fallback silencioso.
