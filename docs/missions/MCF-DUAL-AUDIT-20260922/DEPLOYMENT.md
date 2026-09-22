# Entrega Linux 0.3.0

AppImage gerado com electron-builder 26.16.1 / Electron 44.2.0. Smoke do AppImage corrigido: PASS (duas instâncias reais, bloqueio de duplicata, persistência, restauração e redação de senha). Rodada completa de check, teste, build e smoke encerrou com código 0.

Instalação versionada lado a lado: Aplicativos/mcf-dual-browser-cockpit-0.3.0/MCF-Dual-Browser-0.3.0.AppImage. Atalho de menu: MCF Dual Browser 0.3.0, perfil notebook. Arquivo instalado conferido por SHA-256.

A instalação 0.2.0 e suas janelas não foram substituídas ou encerradas. Portanto os processos já abertos continuam na versão antiga. A nova versão entra em uso pelo novo atalho e pede login inicial no perfil independente. Rollback: fechar apenas o novo perfil e usar o lançador antigo; não apagar dados.

SHA-256 do AppImage: 3f7e53eee74932bcac75ea8f5877923a8362caab3944ca6a9b78f3c511aa075c
