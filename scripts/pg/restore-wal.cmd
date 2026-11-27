@echo off
rem WAL restore helper for the local PostgreSQL 15 lab.
rem PostgreSQL strips backslashes from postgresql.conf values, and cmd copy
rem requires backslashes, so paths are passed with forward slashes and fixed up.
rem Usage: restore-wal.cmd <archive-dir> <wal-file> <destination>
setlocal
set "ARCHIVE=%~1"
set "ARCHIVE=%ARCHIVE:/=\%"
set "DEST=%~3"
copy /Y "%ARCHIVE%\%~2" "%DEST%" >nul
exit /b %ERRORLEVEL%
