@echo off
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo build.cmd: csc.exe not found under %WINDIR%\Microsoft.NET 1>&2
  exit /b 1
)
if not exist "%~dp0bin" mkdir "%~dp0bin"
"%CSC%" /nologo /optimize+ /warn:4 /out:"%~dp0bin\rowpty.exe" "%~dp0src\RowPty.cs"
exit /b %ERRORLEVEL%
