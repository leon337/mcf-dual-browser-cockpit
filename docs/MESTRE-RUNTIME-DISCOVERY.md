# MESTRE — Runtime Discovery do MCF Dual Browser

**Classificação:** protocolo operacional da Execution Surface
**Regra central:** o MESTRE deve descobrir o runtime antes de operar agentes, panes ou Agent Sessions.

## Objetivo

Eliminar descoberta manual do funcionamento do Dual Browser. Um MESTRE novo não deve inferir perfis, rotas, agentes ou critérios de sucesso a partir de histórico de chat.

A fonte operacional primária é:

```text
GET /v1/discovery
```

O endpoint é autenticado pelo Agent Bridge e descreve a instância que respondeu.

## Bootstrap obrigatório do MESTRE

1. localizar o descriptor da instância correta em:
   `~/.config/mcf-dual-browser-cockpit/instances/<instance-id>/agent-bridge.json`;
2. ler `instanceId`, `agentProfile`, `port` e o token sem expor o token em logs/conversa;
3. chamar `GET /v1/discovery` com `Authorization: Bearer <token>` e `X-MCF-Instance: <instance-id>`;
4. usar `current.paneAgents` para saber quais agentes estão vinculados aos dois panes;
5. usar `current.canonicalAgents` para saber quais agentes podem receber Agent Sessions independentes;
6. usar `current.agentSessions` para recuperar sessões já abertas;
7. somente depois selecionar o mecanismo adequado e despachar trabalho.

## Mecanismos expostos

### 1. Pane Agents

Dois panes persistentes por instância: `chat` e `workspace`.

Rotas principais:

- `GET /v1/agents`
- `POST /v1/agents/bootstrap`
- `POST /v1/mission-envelope`
- `GET /v1/missions`
- `GET /v1/mission-status?envelopeId=<id>`
- `GET /v1/mission-result?envelopeId=<id>`

Use quando a missão pertence a um dos agentes vinculados ao perfil da instância.

### 2. Agent Session

Abre uma `BrowserWindow` ChatGPT independente para qualquer agente presente no registro canônico do MCF.

Rotas:

- `GET /v1/agent-sessions`
- `POST /v1/agent-session/open`

A sessão é criada pelo broker `mcf-agent-session`, recebe `session_id`, `trace_id`, missão, contrato canônico e bootstrap.

### 3. Automação direta dos panes

Rotas semânticas/programáticas:

- `GET /v1/state?pane=<chat|workspace>`
- `GET /v1/text?pane=<chat|workspace>`
- `GET /v1/interactive?pane=<chat|workspace>`
- `POST /v1/navigate`
- `POST /v1/message`
- `POST /v1/messages/broadcast`
- `POST /v1/find-click`
- `POST /v1/click`
- `POST /v1/type`
- `POST /v1/capture`

### 4. Canal live MESTRE ↔ agentes

Somente observacional:

- `GET /v1/live/snapshot`
- `GET /v1/live/stream`

O stream não executa missão e não decide terminalidade.

## Invariante de criação de conversa

**Texto presente no composer não é evidência de envio.**

Uma Agent Session só pode ser considerada entregue quando existirem simultaneamente:

1. um turno real de usuário em `[data-message-author-role="user"]` contendo o marker e o `session_id`;
2. o bootstrap não estiver mais presente no composer;
3. a URL possuir identidade de conversa `/c/<conversation-id>`.

Se qualquer condição falhar:

```text
chat_conversation_not_created
```

e a sessão não pode ser promovida a sucesso.

## Compatibilidade com sessões antigas

Versões anteriores podiam persistir `surfaceState=OPEN` quando o bootstrap ainda estava apenas no composer.

O discovery deriva:

- `deliveryVerified=false`;
- `stateWarning=open_without_conversation_evidence`;

quando uma sessão marcada `OPEN` não possui URL de conversa `/c/<id>`.

Esse warning deve bloquear qualquer conclusão automática de que a sessão foi criada corretamente.

## Autoridade

- **LEANDRO** — autoridade humana final.
- **MESTRE** — orquestrador.
- discovery descreve capacidade; não amplia autorização.
- `falseGreenAllowed=false`.

## Regra para futuras extensões

Novo mecanismo do Dual Browser só está pronto para uso geral quando:

1. está exposto em `/v1/discovery`;
2. possui critério de sucesso verificável;
3. possui teste de regressão;
4. está documentado neste runbook;
5. não depende de memória de um chat anterior para ser descoberto.

## Persistência e reinício

Cada instância persiste os URLs de `chat` e `workspace` em `runtime-state.json`.

Quando um URL persistido contém uma conversa real `/c/<conversation-id>`, o startup deve:

1. restaurar a conversa;
2. preservar o URL;
3. **não** executar bootstrap de identidade automaticamente nesse pane;
4. expor separadamente no discovery o estado da conversa e o estado do lifecycle de identidade.

Portanto, uma conversa pode estar corretamente restaurada enquanto `paneAgents[].state` ainda está `ERROR`, `RECONCILING` ou `UNVERIFIED`. Isso não autoriza promover a identidade a `READY`.

O discovery expõe:

- `current.panes[].conversationId` — conversa realmente aberta;
- `current.paneAgents[]` — estado do lifecycle de identidade;
- warning `identity_not_ready_conversation_preserved` quando a conversa foi preservada mas o binding não está READY.

Bootstrap explícito continua disponível em `POST /v1/agents/bootstrap`, porém deve ser tratado como ação potencialmente mutante da superfície e não deve ser disparado automaticamente somente por reinício.
