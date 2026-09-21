@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [ERRO] Node.js 22.12+ nao foi encontrado.
  echo Instale o Node.js LTS e execute este arquivo novamente.
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo [MCF] Instalando dependencias na primeira execucao...
  call npm install || goto :error
)
echo [MCF] Abrindo Dual Browser Cockpit...
call npm start
goto :eof
:error
echo [ERRO] Falha durante a instalacao ou execucao.
pause
exit /b 1
