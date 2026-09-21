# Security

## Boundary

O MCF Dual Browser Cockpit é uma superfície local de execução.

- não publique o Agent Bridge em interfaces externas;
- não versione o diretório de dados do Electron;
- não versione cookies, tokens, dumps de sessão ou capturas contendo segredos;
- trate qualquer operação externa de escrita conforme os gates do MCF;
- reporte vulnerabilidades sem incluir segredos reais em Issues públicas.
