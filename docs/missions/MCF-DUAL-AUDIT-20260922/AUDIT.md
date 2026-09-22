# Auditoria e decisões — 0.3.0

Base Git: a64bed9. Fontes instaladas importadas conforme manifesto SHA-256, mantendo sessões de agentes, workspace auxiliar e upload. Correções semânticas do PR1 preservadas. Executor: MESTRE; não houve revisão independente concluída nesta missão.

| Área examinada | Constatação | Tratamento |
|---|---|---|
| Persistência | Processos escreviam no mesmo runtime-state e descriptor | Perfis nomeados em instances/<id>, escrita atômica, bloqueio de processo duplicado |
| Identidade | Janela e descriptor não identificavam instância | Identidade no título, interface, descriptor e estado HTTP; header opcional X-MCF-Instance rejeita alvo divergente |
| IPC | Handlers não verificavam remetente | Somente frame principal da janela local pode invocar handlers |
| Protocolos | Páginas podiam abrir esquemas externos arbitrários | Bloqueados; abertura humana de HTTP(S) continua disponível |
| Bridge | Comandos concorrentes e nenhuma pausa humana | Uma mutação por vez; concorrente recebe 409; pausa retorna 423 para novos POSTs |
| Privacidade | Leitura de controles retornava valores de senha e formulários | Valores de inputs, textarea, select e contenteditable omitidos nesse endpoint |
| Upload | Allowlist lexical permitia symlink para fora | Comparação de caminhos reais; teste de escape |
| Transporte | Sem validação Host; token reutilizado | Host loopback validado; rotação de token a cada start; timeout de conexão |
| Erros | Detalhes internos expostos em HTTP | Resposta genérica e JSON inválido com 400 |
| Capturas | Permissão dependente do umask | Arquivos novos com 0600 |
| Dependências | npm audit executado | Zero vulnerabilidades conhecidas reportadas na execução |
| UI | Rodapé dizia bridge desligada por padrão, mas iniciava ligada | Texto corrigido, pausa com semântica explícita |
| Distribuição | Instalação local divergente do Git | Importação rastreável e publicação versionada lado a lado |

## Limites reais e backlog
- Pausa impede novas ações; não desfaz nem interrompe ação já iniciada. Não é cancelamento transacional.
- Perfis novos começam sem login. Não copiar cookies de perfis em uso. Instalações antigas permanecem com os riscos antigos até serem encerradas e substituídas pelo usuário.
- Bridge autenticada concede controle do workspace ao portador do token; não substitui autorização por missão. Header de instância é opcional para compatibilidade.
- Correspondência semântica ainda seleciona primeiro resultado; ambiguidade entre frames precisa de evolução específica. Não há idempotência para cliques ou histórico persistente de recibos.
- Upload usa realpath contra symlinks preexistentes; não constitui proteção contra outro processo malicioso do mesmo usuário alterando arquivos durante upload.
- Sessões de agentes e upload foram preservados, mas não foram disparados contra serviços externos durante teste (evitar mensagens e anexos reais). Dependem do broker local e de autenticação.
- Janelas auxiliares existentes mantêm seleção implícita. Abas, seletor de alvo, Voice Hub e painel completo de missões continuam pendentes.
- Auditoria de código e testes direcionados não equivalem a pentest completo nem certificação. Windows não foi empacotado ou testado nesta entrega.

- Downloads de mesmo nome ainda podem sobrescrever arquivos no diretório de downloads; política de colisões permanece no backlog.
