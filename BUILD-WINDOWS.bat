@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo [ERRO] Node.js 22.12+ nao foi encontrado.
  pause
  exit /b 1
)
call npm install || goto :error
call npm run check || goto :error
call npm run dist:win || goto :error
echo [MCF] Build concluido. Veja a pasta release.
pause
goto :eof
:error
echo [ERRO] Build interrompido.
pause
exit /b 1
