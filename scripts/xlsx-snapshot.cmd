@echo off
rem Hourly out-of-repo copy of the untracked spreadsheets in xlsx/. (Task: "Phoenix xlsx Snapshot -
rem Hourly": daily trigger at 03:30 repeating every hour, renamed from "- Daily" 2026-09-09.)
rem
rem WHY THIS EXISTS: .gitignore matches *.xlsx, so the ~103 working sheets in that folder sit in no
rem commit, branch or archive ref. On 2026-09-05 something deleted every PDF in that same folder
rem from every checkout on this machine, twice inside twenty minutes; those were tracked and came
rem back from git, and the sheets beside them would not have.
rem
rem IT RUNS origin/main CODE, NOT THE CHECKOUT S. Measured the same day: pointing the job at
rem "repo-doctor.mjs --snapshot-xlsx" in the primary did NOTHING - that checkout was 38 commits
rem behind, its repo-doctor predated the flag, and an unknown flag is ignored in silence. The job
rem exited 0 and wrote a full, plausible report with no snapshot in it. A working checkout is on
rem whatever branch someone left it on, so only the FOLDER comes from it; the code comes from main.
rem
rem Every way this can quietly do nothing is a loud non-zero exit, because a backup that stops
rem working without saying so is worse than none - it stops anyone looking. No parenthesised blocks:
rem an escaped "&" inside one turned the first version of this file into an echo that exited 0.
rem   1 checkout unreachable   5 could not extract the module   6 main copy has no entry point
rem   2 no destination   3 source unreadable   4 a copy failed to verify   0 copied / nothing to do
setlocal
set "LOG=C:\Users\satoh\.claude\scripts\xlsx-snapshot.log"
set "REPO=F:\Phoenix Workforce\phoenix-workforce"
set "WORK=%TEMP%\phx-xlsx-snapshot"
set "MOD=%WORK%\snapshot.mjs"
>>"%LOG%" echo.
>>"%LOG%" echo ===== %DATE% %TIME% =====
if not exist "%REPO%\xlsx" >>"%LOG%" echo FAILED - %REPO% is not reachable
if not exist "%REPO%\xlsx" exit /b 1
if not exist "%WORK%" mkdir "%WORK%"
rem THE FETCH IS NOT IN THIS JOB ANY MORE - moved out 2026-09-21, and this is the whole point of
rem the split. Measured that night over 22 runs through schtasks: with the fetch inline the job
rem died 0xC000013A about four times in five, always inside
rem   git fetch ... -. git-remote-https -. gh.exe auth git-credential
rem leaving only the ===== header in this log, or a bare fatal: expected flush after ref listing.
rem It NEVER reproduced by hand, at any level of free RAM (it failed 5 of 6 with 5 GB free), and
rem nothing on the machine was killing it - the mem-watchdog log is clean through every failure.
rem What it cost was the BACKUP, which needs no network at all: git show reads the origin/main
rem that the interactive sessions refresh dozens of times a day. So the network step now lives in
rem its own task, Phoenix xlsx Snapshot - Fetch, at :25 past the hour. If that one dies it costs
rem nothing and nothing watches it. Do not fold the fetch back in here.
set "GIT_TERMINAL_PROMPT=0"
git -C "%REPO%" show origin/main:scripts/repo-doctor-xlsx-snapshot.mjs >"%MOD%" 2>>"%LOG%"
set "BAD="
if not exist "%MOD%" set "BAD=1"
for %%A in ("%MOD%") do if %%~zA LSS 1000 set "BAD=1"
if defined BAD >>"%LOG%" echo FAILED - could not extract the module from origin/main
if defined BAD exit /b 5
findstr /C:"--repo" "%MOD%" >nul
if errorlevel 1 >>"%LOG%" echo FAILED - the origin/main copy has no runnable entry point
if errorlevel 1 exit /b 6
node.exe "%MOD%" --repo "%REPO%" >>"%LOG%" 2>&1
>>"%LOG%" echo exit=%ERRORLEVEL%
exit /b %ERRORLEVEL%
