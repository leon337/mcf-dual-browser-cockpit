# Validação

- npm run check: PASS.
- npm test: PASS (2 testes com múltiplas asserções). HTTP real com workspace simulado: autenticação, origem, Host, identidade, pausa, busy, upload symlink, URL com credenciais, JSON malformado, redação de valores e rotação de token. Arquivos reais: separação de perfis e modo 0600.
- xvfb-run -a python3 test/electron-smoke.py: PASS. Duas instâncias reais de Electron, portas/tokens distintos, bloqueio de duplicata, navegação em fixture local, senha omitida, persistência e restauração após reinício.
- Primeira versão do teste Host usava fetch que normalizava Host; substituída por node:http para verificar cabeçalho real.
- Primeiro smoke usava wrapper Node do Electron e esperava término do wrapper. Corrigido para executar binário Electron diretamente; o bloqueio de duplicata passou.
- npm audit: 0 vulnerabilidades conhecidas nesta execução.
- Duplicata encerra com app.exit(0) antes de inicializar recursos; harness encerra grupos de processos próprios para não deixar filhos de wrappers.
- Build e smoke do AppImage final: PASS. Instalação lado a lado com checksum: PASS. Ver DEPLOYMENT.md.
