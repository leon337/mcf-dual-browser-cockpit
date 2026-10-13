# Implantação local do MCF Dual Browser Cockpit 0.7.2

## Checklist

- [x] Integrar painel de controle, configurações persistentes e observabilidade à `main`.
- [x] Executar `npm test` (99 testes aprovados na validação da versão 0.7.2).
- [x] Gerar AppImage Linux x86_64.
- [x] Validar registro canônico de agentes: 29 entradas e 29 contratos referenciados.
- [x] Instalar o AppImage mantendo o pacote anterior para rollback.
- [x] Configurar launchers locais para exportar `MCF_REPO_PATH` apontando ao repositório canônico.
- [ ] Validar visualmente a interface no AppImage instalado.
- [ ] Verificar eventos reais de bridge/observabilidade após reiniciar instâncias em janela de manutenção.

## Caminho canônico de agentes

O runtime `mcf-agent-session` usa `MCF_REPO_PATH` quando definido. Em notebooks onde o repositório canônico está em outro local, os launchers devem exportar o caminho real antes de iniciar o Electron. Não criar cópias divergentes do registro para contornar caminhos ausentes.

## Atualização e rollback

1. Gerar o pacote com `npm run dist:linux`.
2. Confirmar `npm test` e comparar o SHA-256 do pacote gerado com o pacote instalado.
3. Instalar a nova versão com nome versionado; não sobrescrever a anterior.
4. Atualizar os launchers e validar sua sintaxe com `bash -n`.
5. Preservar dados de usuário e sessões autenticadas; reiniciar instâncias apenas numa janela de manutenção.
6. Para rollback, apontar o launcher ao AppImage versionado anterior e revalidar o caminho canônico.

## Evidências da versão 0.7.2

- Merge da integração: `f4924bc`.
- Testes: 99 aprovados, 0 falhas.
- Registro: 29 agentes únicos; todos os contratos referenciados existem.
- SHA-256 AppImage: `a0419715b565afcbf7f29270badd3f9cf06648193eebbf025fe0f2649dba9071`.
