MCF Dual Browser Cockpit 0.3.0 — isolamento e controle da automação

Esta versão adiciona perfis nomeados com --instance=notebook, identidade visível e persistência independente. A Bridge ganha pausa humana, rejeição de ações simultâneas, validação de Host/IPC, rotação de token e ocultação de valores de formulário. Uploads verificam caminhos reais. Recursos locais de sessões de agentes e workspace auxiliar foram preservados.

Perfis novos exigem login inicial. A instalação antiga não é removida nem recebe migração automática. Pausa bloqueia novas ações; ações em curso podem terminar. Windows e fluxos externos do broker não foram validados. Consulte docs/missions/MCF-DUAL-AUDIT-20260922/AUDIT.md para todos os limites.

Missão: #2. Testes: Node HTTP, persistência e smoke Electron. Consulte VALIDATION.md e DEPLOYMENT.md para evidência final do pacote.
