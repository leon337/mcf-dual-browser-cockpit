# QA nativo dos 40 controles — execução e interpretação

Esta suíte testa a **casca Electron 0.7.5** em um runner Linux isolado, não as conversas reais de LEANDRO. O inventário de referência é `capabilities/control-catalog.v1.json`.

## Comando

Em runner Ubuntu com Node 22, Python 3.12, Electron instalado, Xvfb, xclip e `websockets==14.2`:

```bash
npm ci
npm test
python test/electron-all-controls-ci.py
```

O workflow `.github/workflows/control-e2e.yml` executa esses passos em PRs e por despacho manual. O artefato `qa-artifacts/controls-e2e.json` contém uma linha por seletor, com `PASS`, `FAIL` ou `BLOCKED`. **Não interpretar um clique ou toast como prova de funcionamento.** A aprovação integral exige `passed=40`, `failed=0`, `blocked=0`, mais `npm test` aprovado.

## Isolamento e responsabilidade

- HOME, XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, instância, CDP, bearer e clipboard gerados no runner descartável.
- Navegação entre páginas é executada com fixtures HTTP em `127.0.0.1`. URLs de home podem apontar a destinos públicos, mas não têm sessão autenticada. Nenhuma mensagem é enviada a chats reais.
- Abertura externa é substituída por um handler local que grava apenas URLs de fixture; falha se ele não confirmar o acionamento.
- Captura deve produzir PNG válido em `Pictures` do perfil descartável com permissão `0600`.
- A cópia de token é validada por igualdade no clipboard do display isolado **sem imprimir o token**, e a cópia do catálogo verifica JSON sanitizado.
- Pausa/retomada da Bridge, mudanças de preferências e histórico ocorrem apenas na instância `qa-controls`, não na instância real `notebook`.
- O verificador exige que os 40 seletores catalogados estejam cobertos por evidência individual; resultados restantes tornam-se `BLOCKED` e o processo retorna erro.

## Gate de promoção e rollback

Aprovação em CI **não autoriza merge automático nem instalação no notebook**. A promoção necessita revisão independente, confirmação de ausência de alterações indesejadas e smoke local de ambas as conversas e Bridge. Manter os backups/lançadores anteriores e testar a reversão em ambiente isolado. Não reativar TRI 0.8.0.

## Falhas e limitações

`FAIL` indica ausência de readback ou operação incorreta, `BLOCKED` indica que a execução não chegou ao seletor, e `PASS` exige efeito confirmado no runner. Resultados em Ubuntu/Xvfb não comprovam integração com o desktop Linux Mint; validar esses pontos localmente antes do aceite final. A suíte não cria uma API de execução genérica, não contorna controles IPC ou políticas de autenticação.
