@echo off
rem =====================================================================
rem Inicia el sistema con doble clic: abre una ventana para el servidor,
rem otra para el nodo de borde y luego el tablero en el navegador.
rem Para detener todo, cierre las dos ventanas.
rem Requiere la instalacion del README (.venv, servidor\node_modules y .env).
rem =====================================================================
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo No se encontro el entorno de Python en .venv. Vea "Instalacion" en el README.
  pause
  exit /b 1
)
if not exist "servidor\node_modules" (
  echo Faltan las dependencias del servidor. Vea "Instalacion" en el README.
  pause
  exit /b 1
)
if not exist ".env" (
  echo Falta el archivo .env con las credenciales. Vea "Configuracion" en el README.
  pause
  exit /b 1
)

start "Servidor - Ensayo de corte de cacao" cmd /k "cd /d servidor && node server.js"
timeout /t 8 /nobreak >nul
start "Nodo de borde - Ensayo de corte de cacao" cmd /k ".venv\Scripts\python.exe edge\main.py"
timeout /t 6 /nobreak >nul
start "" http://localhost:3000
