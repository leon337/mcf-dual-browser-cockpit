# Checklist operacional — Agent Bridge e Instagram

## Objetivo
Identificar sem ambiguidade a instância do MCF Dual Browser Cockpit que controla a Agent Bridge na porta `44993`, autenticar pelo mecanismo oficial da instância, navegar para `https://www.instagram.com/` e confirmar a URL final.

## Checklist
- [x] Confirmar que a bridge na porta `44993` responde em `/health`.
- [x] Confirmar que as bridges nas portas `47831` e `43325` também respondem; não presumir que pertencem à mesma instância.
- [x] Identificar o mecanismo oficial de token via `cockpit.bridge.getState()` / `cockpit.bridge.copyToken()` no IPC do cockpit.
- [x] Mapear a porta `44993` à instância Electron `--instance=principal` (PID 518286), via `sudo ss -ltnp` e `/proc/<pid>/cmdline`; tokens não foram expostos.
- [ ] Obter o token somente da instância associada à porta `44993`.
- [ ] Enviar `POST /v1/navigate` para `https://www.instagram.com/`.
- [ ] Consultar `GET /v1/state` e validar URL e título resultantes.
- [ ] Corrigir divergências comprovadas e repetir os testes necessários.
- [ ] Registrar evidências e resultado final neste documento.

## Critérios de segurança e conclusão
- Nunca imprimir, registrar em logs, commitar ou compartilhar tokens.
- Não reiniciar nem alterar sessões autenticadas sem necessidade comprovada.
- Não declarar a navegação concluída sem confirmação do estado retornado pela bridge.
- Após validar a navegação, avançar para a próxima etapa da missão e atualizar este checklist.

## Estado verificado
- `44993/health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`.
- `47831/health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`.
- `43325/health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`.
- Porta `44993` pertence ao processo Electron da instância `principal` (PID 518286).
- Porta `43325` pertence à instância `notebook` (PID 518285), com depuração remota na porta `9334`.
- Porta `47831` pertence à instância `notebook-team2` (PID 518287).
- A instância `principal` não expõe atualmente uma porta de depuração remota. O atalho para abrir DevTools não criou janela de depuração; o token deve ser obtido pelo fluxo oficial da instância sem reiniciar sessões autenticadas.
- A navegação para Instagram ainda não foi confirmada.
