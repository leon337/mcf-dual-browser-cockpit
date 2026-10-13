# MCF Dual Browser Cockpit 0.7.5

## Mudanças
- Adicionada seção **Controle da automação** dentro de `CONTROLE → Configurações`.
- Estado em tempo real para bridge desligada, automação pausada, ação em curso e automação liberada.
- Botão de pausar/retomar reutiliza o IPC confiável existente; não contorna o bloqueio de segurança da Agent Bridge.
- Explicação explícita de que a pausa impede novas ações, mas não cancela uma ação já iniciada.
- Três testes de regressão para UI, estados e integração com o IPC.

## Verificação
- `npm test`: 102 testes passaram, 0 falharam.
- `git diff --check`: aprovado.
- Build AppImage e inspeção visual: pendentes até conclusão do empacotamento desta release.
