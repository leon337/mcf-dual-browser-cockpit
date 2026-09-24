# Validação — MCF-DUAL-AGENT-IDENTITY-001

## Código

- versão validada: 0.4.3
- npm run check: PASS
- npm test: PASS — 15/15
- git diff --check: PASS
- manifests empacotados em agents/**/*
- AppImage Linux gerado e instalado lado a lado

## Artefato

- MCF Dual Browser Cockpit 0.4.3 Linux x86_64 AppImage
- SHA-256: 6ef38312b97463dd54fabfeccd499d5bbdafca0073a94e00f39c4733d7603127

## Identidade real no perfil notebook

### Emily

- pane: chat
- role: Auditoria Independente
- contract digest: 9385ac2330d966133814c899540e9f33daad0f5eb423ec6a0a3e4a0bb48d70f4
- state: READY
- handshakeVerified: true
- bootstrap receipt: IDENTITY_BOOTSTRAP_DELIVERED
- readiness receipt: HANDSHAKE_VERIFIED

### Sofia

- pane: workspace
- role: Arquitetura de Software
- contract digest: 06ffc53d7466471b1541070990b02acde1a7350a63cb41b1b299f3ef0f28b6f3
- state: READY
- handshakeVerified: true
- bootstrap receipt: IDENTITY_BOOTSTRAP_DELIVERED
- readiness receipt: HANDSHAKE_VERIFIED

## Smoke de Mission Envelope

### Sofia

- missionId: MCF-DUAL-AGENT-IDENTITY-001-SOFIA-FINAL
- MISSION_QUEUED receipt: fb7b7c44-2320-4485-8822-dd99d3c5b03c
- MISSION_DELIVERED receipt: e9786fec-b3d3-4369-b9ff-a9eabe9f5758
- MISSION_ACCEPTED receipt: 8a021cca-32af-450e-a3ae-1536e9de2cf6
- comportamento semântico observado: resposta arquitetural curta sobre separação entre identidade, navegador e receipts

### Emily

- missionId: MCF-DUAL-AGENT-IDENTITY-001-EMILY-FINAL
- MISSION_QUEUED receipt: fe5e577f-75c8-4372-841f-f9ddedf7d652
- MISSION_DELIVERED receipt: 37b69dfc-b756-4df0-b7c6-b7b9efe0bb77
- MISSION_ACCEPTED receipt: c4f63967-e832-4511-b8fe-997b2d782fb3
- comportamento semântico observado: resposta restrita à auditoria de identidade, handshake e receipts, sem alteração de código

## Concorrência

Os dois POSTs finais de /v1/mission-envelope retornaram em milissegundos com MISSION_QUEUED. Entrega e aceite ocorreram posteriormente por fila de pane. Isso elimina o conflito anterior entre socket de 30s e espera de aceite de até 60s.

## Não alegado

Este resultado prova binding de identidade, contrato, sessão, handshake, roteamento, Mission Envelope e receipts. Não prova independência cognitiva das instâncias nem substitui gates humanos/MCF aplicáveis.
