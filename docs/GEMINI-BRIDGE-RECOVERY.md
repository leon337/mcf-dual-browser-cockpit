# Gemini — recuperação governada do Agent Bridge (0.7.6)

Escopo: Dual Browser Cockpit, instâncias isoladas e endpoints autenticados de loopback. Origem: incidente de 17/11/2026 em que o Gemini mostrou “Raciocínio concluído” e “Pensando…” simultaneamente, com botão “Parar resposta”.

## Diagnóstico

A verificação anterior reconhecia principalmente bolhas ChatGPT. O Gemini usa elementos Angular user-query-content, por isso o envio gerava message_send_unconfirmed mesmo quando o site recebia a mensagem. O detector de geração ativa também não reconhecia “Parar resposta”.

## Solução

1. POST /v1/message valida editor e controles antes de digitar. Espera uma geração ativa terminar ou falha em modo fechado; não clica em Stop nem faz retry automático.
2. O verificador Gemini extrai turnos não vazios de user-query-content, confere texto integral, nova contagem/assinatura, identidade da conversa e editor vazio. O ChatGPT mantém suporte às bolhas modernas e legadas.
3. Após um único clique de envio, aguarda até 8,25 s no Gemini para confirmação. Se não houver prova, retorna message_send_unconfirmed com retrySafe:false e armazena envio incerto apenas em memória. A repetição bloqueia com message_delivery_reconciliation_required.
4. GET /v1/message-recovery?pane=workspace tenta reconciliação sem reenviar. POST /v1/message-recovery/acknowledge com {"pane":"workspace","confirm":true} reconhece a incerteza e permite continuar, mas NÃO comprova que o site não recebeu a mensagem. O operador deve conferir antes de reenviar.
5. GET /v1/generation-status?pane=workspace analisa o botão de parada, estado “Pensando…” e hash da resposta. Detecta suspectedStall:true após 90 s SEM mudança de assinatura, exigindo pelo menos duas inspeções. Não interrompe automaticamente.
6. POST /v1/generation/recover exige {"pane":"workspace","confirm":true,"fingerprint":"<status.fingerprint>"}. Somente atua se a assinatura ainda for igual e o estado suspeito estiver ativo; clica “Parar resposta”, confirma apenas o diálogo exato “Sim, cancelar” e verifica o fim da geração.
7. Todas as rotas herdam token Bearer local, validação do X-MCF-Instance, origem, host, fila de mutações, pausa e checkpoints de recuperação MCF. Nenhum token é retornado nas inspeções.

## Procedimento operacional

Usar a porta do Agent Bridge da instância local e token da sua configuração privada em memória. Nunca incluir o token em mensagens, logs, links ou arquivos de código. Consultar GET /v1/generation-status duas vezes, com intervalo superior a 90 segundos, antes de considerar cancelamento governado. Consultar GET /v1/message-recovery antes de repetir um envio incerto.

## Testes e implantação

npm test contempla testes de DOM Gemini, placeholders, detecção de novo turno, isolamento entre conversas, Parar resposta, timeout, recuperação condicionada, não duplicação e recursos preexistentes.

A publicação do código não troca automaticamente o processo Electron em execução. O deploy local requer reinício da instância monitor preservando seus perfis, parâmetros e sessão notebook. O rollback exige cópia reversível do código e reinício com mesmos parâmetros, sem apagar diretórios de usuário.

## Limites

A UI do Google pode mudar seus seletores. A constância do hash é heurística, não prova falha do modelo. Nenhum cancelamento automático de geração foi habilitado. O registro de entrega incerta é volátil no reinício. Não são alteradas as permissões GitHub nem as regras HUMAN_GATE do MCF.

Fonte canônica: https://github.com/leon337/multiagent-collaboration-framework
