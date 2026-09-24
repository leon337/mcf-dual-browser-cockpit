# Instâncias, pausa e atualização

A versão 0.3.0 permite escolher uma identidade estável na inicialização:

```sh
./MCF-Dual-Browser-0.3.0.AppImage --instance=notebook
./MCF-Dual-Browser-0.3.0.AppImage --instance=monitor
```

IDs aceitam letras minúsculas, números e hífen (até 48 caracteres). Sem argumento, o perfil é principal. No Linux, dados ficam em ~/.config/mcf-dual-browser-cockpit/instances/<id>. Cada perfil tem cookies, sessão, estado e agent-bridge.json próprios. Uma segunda abertura do mesmo perfil ativa sua janela existente.

A versão antiga permanece separada e os perfis novos exigem autenticação inicial. Não há migração automática de cookies. Não encerre sessões antigas com trabalhos não salvos.

A interface mostra a identidade da instância. PAUSAR bloqueia novos comandos de automação; uma ação já iniciada pode terminar. RETOMAR libera novos comandos. O botão Agent Bridge desliga ou liga o servidor inteiro. Os controles humanos de navegação continuam disponíveis durante pausa.

Agentes devem ler o descriptor do perfil correto, manter o token privado e enviar X-MCF-Instance com o ID esperado. Respostas 409 automation_busy exigem observar o estado antes de decidir repetir. Não repetir cliques cegamente. 423 automation_paused exige respeitar a pausa humana.

Produção desktop é distribuída como AppImage, não como um site Vercel. A página Atlas permanece independente. Para reverter, feche somente a nova instância e execute o AppImage 0.2.0 preservado. Não apagar perfis.

## Mensagens programáticas sem GUI

A partir da versão 0.3.3, a Agent Bridge pode enviar mensagens diretamente aos dois painéis sem usar mouse, teclado do sistema ou foco de janela.

Rotas:

    POST /v1/message
    {"pane":"chat|workspace","message":"..."}

    POST /v1/messages/broadcast
    {"targets":["chat","workspace"],"message":"..."}

Aliases aceitos: emilly/emily -> chat e sophia/sofia -> workspace. O broadcast executa os alvos concorrentemente.

A Bridge só declara sucesso quando o envio é confirmado pelo esvaziamento do compositor. Bloqueios reais do produto, como rate_limit_hard_block, são reportados por alvo e não são contornados.
