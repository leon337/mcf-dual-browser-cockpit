# MCF-DUAL-AUDIT-20260922

Autoridade: LEANDRO. Executor: MESTRE nesta sessão. Autorização explícita: auditar, corrigir e publicar em produção sem nova confirmação.

Objetivo: corrigir riscos concretos do Cockpit preservando recursos instalados, sessões existentes e possibilidade de reversão.
Escopo desta entrega: isolamento de instância e persistência; identidade visível; proteção da Bridge e IPC; pausa humana; validação automatizada; pacote Linux e documentação.
Fora desta entrega: novo Voice Hub, abas completas, migração de cookies e simulação de agentes independentes.
Risco: alteração de aplicativo desktop com automação local. Publicação somente após testes; não encerrar sessões em andamento. Instalação versionada lado a lado.
Critérios: testes HTTP reais da Bridge; teste de dois perfis Electron; build AppImage; preservação das extensões locais e controles semânticos do PR1; registro de limitações e rollback.
Evidências: código e relatório versionados neste diretório; release vinculada ao commit; nenhum token, cookie, conteúdo de chats ou imagem privada publicado.
Gates: validação técnica executada por MESTRE; não representar análise interrompida por subagentes como revisão independente concluída.
