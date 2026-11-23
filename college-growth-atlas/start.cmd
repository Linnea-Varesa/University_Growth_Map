@echo off
REM ============================================================
REM  大学成长地图 · 在线工作台  一键启动
REM  启动后浏览器打开 http://127.0.0.1:8787/
REM ============================================================
setlocal
cd /d "%~dp0"

set PORT=8787
if not "%~1"=="" set PORT=%~1

echo.
echo   大学成长地图 · 在线工作台
echo   ---------------------------------------------
echo   数据存储：data\db.json （6 张表，在线存储）
echo   双向同步：SSE  /api/events
echo   访问地址：http://127.0.0.1:%PORT%/
echo   ---------------------------------------------
echo   按 Ctrl+C 停止服务
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 18+ ^(https://nodejs.org^)
  pause
  exit /b 1
)

start "" http://127.0.0.1:%PORT%/
node server.mjs
pause
