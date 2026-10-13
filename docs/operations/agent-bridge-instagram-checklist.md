# Checklist operacional — Agent Bridge, observabilidade e Meta Business

## Objetivo
Validar a observabilidade da Agent Bridge `44993`, testar navegação para uma URL pública neutra e abrir o Meta Business na instância `principal` para diagnosticar dificuldades de navegação.

## Checklist
- [x] Confirmar saúde da bridge em `/health`.
- [x] Confirmar que as bridges `44993`, `47831` e `43325` estão ativas.
- [x] Mapear `44993` para a instância Electron `principal` (PID 518286).
- [x] Obter o token somente pela interface oficial; token nunca impresso ou registrado.
- [x] Validar `GET /v1/state`.
- [x] Validar `GET /v1/text` sem persistir o conteúdo integral da página.
- [x] Validar `GET /v1/interactive`.
- [x] Validar `GET /v1/accessibility`.
- [x] Testar `POST /v1/navigate` para `https://example.com/` e registrar o bloqueio retornado.
- [ ] Abrir `https://business.facebook.com/` pela bridge.
- [ ] Inspecionar a página Meta Business e documentar obstáculos de navegação/autenticação.
- [ ] Corrigir no código os obstáculos confirmados, criar testes de regressão e repetir a validação.

## Evidências de observabilidade
- `GET /health`: HTTP 200; serviço `mcf-dual-browser-agent-bridge`, versão 1.
- `GET /v1/state`: HTTP 200; retorna URL, título, loading, histórico e estado de automação.
- `GET /v1/text`: HTTP 200; retornou URL/título e texto da página; somente tamanho e presença de prompts genéricos foram avaliados, sem armazenar o texto.
- `GET /v1/interactive`: HTTP 200; página Instagram apresentou 94 nós interativos.
- `GET /v1/accessibility`: HTTP 200; árvore de acessibilidade retornou 909 nós, 572 não ignorados.
- `POST /v1/navigate` para `https://example.com/`: HTTP 423 com `automation_paused`; a URL e o título permaneceram no Instagram. Repetição confirmou o bloqueio.
- A bridge está saudável, mas a ação de navegação fica bloqueada enquanto a automação está pausada. Esse é o obstáculo primário observado; não foi alterado automaticamente o estado de pausa.
- A tentativa de navegação para Meta Business ainda não foi concluída. Não afirmar que o site foi aberto.
- Nenhum token ou dado privado de conta foi incluído neste documento.

## Diagnóstico preliminar
A observabilidade de leitura funciona. A navegação falha por bloqueio explícito `automation_paused` (HTTP 423), não por indisponibilidade da bridge. Antes de modificar o código, deve-se localizar a origem do estado de pausa e a ação de interface documentada para retomá-la; manter a pausa como controle de segurança até ser claro que a instância pode prosseguir.

## Resultado atual
**PARCIAL** — endpoints de observabilidade verificados; navegação e inspeção do Meta Business pendentes por automação pausada.
