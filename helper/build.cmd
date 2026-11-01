@echo off
rem Сборка NCXHelper.exe встроенным в Windows компилятором C# (.NET Framework 4.x)
cd /d "%~dp0"
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
"%FW%\csc.exe" /nologo /target:winexe /optimize+ /codepage:65001 /win32icon:icon.ico /out:..\download\NCXHelper.exe ^
  /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:"%FW%\System.Web.Extensions.dll" NCXHelper.cs
