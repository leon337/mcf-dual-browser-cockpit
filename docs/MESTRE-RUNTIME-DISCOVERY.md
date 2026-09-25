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

## Benchmark de retomada rápida — protocolo do MESTRE

**Data de calibração inicial:** 2026-09-25  
**Host observado:** `leo-N43SM`  
**Build observado:** `0.6.2`

### Objetivo

Reduzir o tempo de retomada de uma instância já configurada sem sacrificar persistência ou criar falso verde.

O caminho rápido não deve recriar chats nem executar bootstrap quando os URLs persistidos já apontam para conversas reais.

### Caminho recomendado

```text
1. confirmar que a instância desejada não está duplicada;
2. executar o launcher persistente da instância;
3. ler agent-bridge.json até obter pid/port/token atuais;
4. validar GET /v1/state para chat e workspace;
5. considerar retomada funcional quando:
   - os dois URLs coincidem com runtime-state.json;
   - ambos possuem a conversa esperada;
   - loading=false nos dois panes;
6. chamar GET /v1/discovery somente depois da restauração para inventário operacional.
```

Para `notebook`, o launcher persistente observado é:

```text
/home/leo/Aplicativos/mcf-dual-browser-cockpit/launch-notebook.sh
```

Não reconstruir manualmente URLs quando `runtime-state.json` já possui `/c/<conversation-id>`.

### Métricas obrigatórias por onda

Registrar separadamente:

- `stop_ms` — solicitação de encerramento até saída do processo principal;
- `bridge_ms` — lançamento até Agent Bridge responder;
- `url_match_ms` — lançamento até os dois panes exibirem os URLs persistidos;
- `ready_ms` — lançamento até os dois panes estarem com URL correto e `loading=false`;
- versão do build;
- instance id;
- resultado PASS/FAIL de preservação das conversas.

Não usar timeout do orquestrador como tempo de startup. A medição deve ocorrer no host, com relógio monotônico/milisegundos, e o resultado deve ser persistido antes do encerramento do comando.

### Onda inicial observada

Uma medição exploratória com polling agressivo de 50 ms preservou os dois URLs, mas não atingiu o critério `loading=false` dentro da janela de medição. O runtime ficou funcional posteriormente com ambos os panes restaurados.

Resultado: **não usar polling agressivo como benchmark canônico**. Ele adiciona carga justamente durante a inicialização do Electron/ChatGPT e pode distorcer a medição.

### Próximas ondas

O benchmark deve evoluir por ondas controladas, alterando uma variável por vez:

1. **Onda A — baseline leve:** polling entre 250 e 500 ms, sem chamadas extras;
2. **Onda B — descriptor-first:** aguardar troca de PID/token antes de consultar panes;
3. **Onda C — readiness mínimo:** medir separadamente Bridge pronto, URLs restaurados e carregamento completo;
4. **Onda D — otimização do launcher/runtime:** somente após A-C mostrarem onde está o gargalo;
5. **Onda E — repetição:** pelo menos 5 ciclos do candidato mais rápido, reportando mediana e p95.

### Critério para promover uma otimização

Uma variante só pode substituir o procedimento anterior quando:

- preserva 100% dos conversation IDs;
- não inicia instâncias não solicitadas;
- não exige bootstrap desnecessário;
- não produz `falseGreen`;
- reduz a mediana de `ready_ms` em medições repetidas;
- continua compatível com `GET /v1/discovery`.

O menor tempo isolado não é suficiente; a meta é o menor tempo **repetível e seguro**.

