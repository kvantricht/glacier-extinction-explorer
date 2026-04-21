@echo off
set PYTHON_EXE=C:\Users\VTRICHTK\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe

if not exist "%PYTHON_EXE%" (
  echo Bundled Python runtime was not found at:
  echo   %PYTHON_EXE%
  exit /b 1
)

if not exist "%~dp0data\swiss_glaciers.geojson" (
  echo Building browser-friendly GeoJSON from test_swiss.parquet...
  set PYTHONPATH=%~dp0.vendor\pyarrow
  "%PYTHON_EXE%" "%~dp0scripts\build_geojson.py"
  if errorlevel 1 exit /b %errorlevel%
)

echo Serving Swiss Glacier Extinction Explorer at http://127.0.0.1:4173
"%PYTHON_EXE%" -m http.server 4173
