@echo off
rem Stop the background html-anything server started by start.vbs.
"%~dp0runtime\node.exe" "%~dp0launch.js" --stop
