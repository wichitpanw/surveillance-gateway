@ECHO OFF
REM ---------------------------------------------------------------------------
REM Start the gateway under PM2. Invoked by the boot Scheduled Task.
REM
REM Comments here are ASCII on purpose: a .cmd is read by cmd.exe using whatever
REM code page the session happens to have, and a non-interactive task session is
REM not guaranteed to match the one you tested in. Thai text here can corrupt the
REM parse. The reasoning in Thai lives in agents.md instead.
REM
REM Three things this avoids, each of which broke the task before:
REM
REM  1. npm's pm2.cmd shim. It ends with a `title %COMSPEC%` trick that assumes a
REM     console exists. The boot task logs on as S4U and has none, and the shim
REM     exits 1 without starting anything. Calling node against pm2's own entry
REM     point skips the shim entirely.
REM  2. Anything under the user's AppData\Roaming or ~/.pm2. Those are redirected
REM     into the Claude desktop app's package cache for processes running inside
REM     it, so a pm2 installed from such a session is invisible to this task, to
REM     an ordinary shell, and to cmd.exe -- and its home would disappear with
REM     that cache. pm2 and its home therefore live on D:, which nothing
REM     redirects. Do not "fix" these paths back to the profile.
REM  3. `pm2 resurrect`, which replays dump.pm2 -- state written by whoever last
REM     ran `pm2 save`. The ecosystem file is in git at a known path and is the
REM     thing we actually want running, so start from that instead.
REM ---------------------------------------------------------------------------

SET "PM2_HOME=D:\gw-pm2\home"
SET "NODE_EXE=C:\Program Files\nodejs\node.exe"
SET "PM2_JS=D:\gw-pm2\npm\node_modules\pm2\bin\pm2"
SET "REPO=D:\gateway-dashboard"
SET "LOG=%PM2_HOME%\boot-start.log"

ECHO ==== %DATE% %TIME% starting gateway ====>> "%LOG%"

IF NOT EXIST "%NODE_EXE%" (
  ECHO node not found at %NODE_EXE%>> "%LOG%"
  EXIT /B 2
)
IF NOT EXIST "%PM2_JS%" (
  ECHO pm2 entry not found at %PM2_JS%>> "%LOG%"
  EXIT /B 3
)

CD /D "%REPO%" || (ECHO cannot cd to %REPO%>> "%LOG%" & EXIT /B 4)

REM startOrRestart is safe whether or not the apps are already up, so a manual
REM run of this task is never destructive.
"%NODE_EXE%" "%PM2_JS%" startOrRestart "%REPO%\ecosystem.windows.config.cjs" >> "%LOG%" 2>&1
SET "RC=%ERRORLEVEL%"

REM Since 2026-09-23 this machine also runs an edge (Surveillance Gateway Edge, port
REM 5273). pm2 save does not help here - this task never resurrects - so the
REM edge's ecosystem file has to be started explicitly or it stays down after
REM every reboot. On a central without an edge the file is simply absent.
IF NOT EXIST "D:\gateway-regional\regional.json" (
  IF EXIST "%REPO%\ecosystem.edge.config.cjs" (
    "%NODE_EXE%" "%PM2_JS%" startOrRestart "%REPO%\ecosystem.edge.config.cjs" >> "%LOG%" 2>&1
    IF ERRORLEVEL 1 SET "RC=5"
  )
)
REM The new provincial Edge runs beside the old Edge during M1 and remains after M2.
IF EXIST "D:\gateway-provincial\edge.json" (
  "%NODE_EXE%" "%PM2_JS%" startOrRestart "%REPO%\ecosystem.provincial.config.cjs" >> "%LOG%" 2>&1
  IF ERRORLEVEL 1 SET "RC=7"
)
REM Regional is opt-in: its state/config is created only after the M0 backup.
IF EXIST "D:\gateway-regional\regional.json" (
  "%NODE_EXE%" "%PM2_JS%" startOrRestart "%REPO%\ecosystem.regional.config.cjs" >> "%LOG%" 2>&1
  IF ERRORLEVEL 1 SET "RC=6"
)
ECHO ==== exit %RC% ====>> "%LOG%"
EXIT /B %RC%
