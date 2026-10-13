# Checklist operacional — Agent Bridge e Instagram

## Objetivo
Identificar a instância do MCF Dual Browser Cockpit que controla a Agent Bridge na porta `44993`, autenticar pelo mecanismo oficial, navegar para `https://www.instagram.com/` e confirmar a URL final.

## Checklist de execução
- [x] Confirmar que a bridge na porta `44993` responde em `/health`.
- [x] Confirmar as bridges nas portas `47831` e `43325`.
- [x] Identificar o mecanismo oficial de token via botão de cópia do cockpit (`cockpit.bridge.copyToken()`); o token não foi exibido nem registrado.
- [x] Mapear a porta `44993` à instância Electron `principal` (PID 518286), usando `sudo ss -ltnp` e `/proc/<pid>/cmdline`.
- [x] Obter o token da instância correta pela interface oficial, sem reiniciar a sessão.
- [x] Enviar `POST /v1/navigate` para `https://www.instagram.com/`.
- [x] Consultar `GET /v1/state` e validar URL, título e carregamento.
- [x] Registrar as evidências e atualizar este checklist.

## Evidências verificadas
- `GET http://127.0.0.1:44993/health`: HTTP 200, serviço `mcf-dual-browser-agent-bridge`, versão 1.
- `GET /v1/state` antes da navegação: instância `principal`, painel `workspace`, URL inicial ChatGPT, `paused=false`, `busy=false`, `queueDepth=0`.
- `POST /v1/navigate` com `https://www.instagram.com/`: HTTP 200, `ok=true`.
- `GET /v1/state` após a navegação: HTTP 200; URL final `https://www.instagram.com/`; título `Instagram`; `loading=false`; instância `principal`.
- As sessões autenticadas foram preservadas; não foi necessário reiniciar o cockpit.
- O token não foi impresso, incluído no checklist ou publicado.

## Resultado
**CONCLUÍDO** — a Agent Bridge da instância `principal` navegou para Instagram e o estado retornado confirmou a URL e o título esperados.

## Próxima etapa
A navegação de teste está concluída. Para avançar a missão de forma segura, o próximo passo é verificar o fluxo de navegação e observabilidade do cockpit com uma segunda URL de teste não autenticada e documentar o comportamento de retorno/erro, sem interagir com contas nem alterar sessões existentes.
