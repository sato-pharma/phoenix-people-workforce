# Refreshes origin/main for the hourly spreadsheet backup, and NOTHING else.
#
# WHY IT IS ITS OWN JOB (2026-09-21). "Phoenix xlsx Snapshot - Hourly" used to run this fetch inline,
# as the first real step of xlsx-snapshot.cmd. Measured that night over 22 runs through schtasks, it
# killed the whole backup about four times in five: cmd.exe exited 0xC000013A - what the task list
# calls "killed (Ctrl+C / closed)" - roughly two seconds in, leaving only the ===== header in
# xlsx-snapshot.log, or a bare "fatal: expected flush after ref listing". It died inside
#     git fetch  ->  git-remote-https  ->  'C:\Program Files\GitHub CLI\gh.exe' auth git-credential
# which is what .gitconfig configures for github.com. It NEVER reproduced when the same .cmd was run
# by hand, it was NOT memory (it failed 5 of 6 runs with 5 GB free), and nothing on this machine was
# killing it - mem-watchdog.log is clean through every one of those failures.
#
# The backup itself needs no network: "git show origin/main:<file>" reads whatever the interactive
# sessions last fetched, which on this machine is dozens of times a day. So the fragile step is here,
# on its own trigger, and its failure costs nothing.
#
# THE CREDENTIAL IS NOT THE PROBLEM - measured 2026-09-21 02:19. gh keeps its token in the Windows
# keyring and "gh auth git-credential" answers perfectly well from a Task Scheduler process: this job
# fetched rc=0 four runs out of four and wrote a fresh FETCH_HEAD. The rc=128 this file logged at
# 02:18 was a bug in the line below, not an auth failure - do not go hunting for a credential fix on
# the strength of an old rc=128.
#
# IT ALWAYS EXITS 0, DELIBERATELY. Start-Process gives git its own console, so when git dies this
# host survives, writes the real rc to the log, and reports success to Task Scheduler - otherwise the
# weekly config review would raise the same "ended badly" finding all over again, for a job whose
# failure is harmless by design. Read the FETCH lines in xlsx-snapshot.log to see how it is really
# doing; a long run of non-zero rc there means the gh credential needs attention.

$ErrorActionPreference = 'SilentlyContinue'
$log  = 'C:\Users\satoh\.claude\scripts\xlsx-snapshot.log'
$repo = 'F:\Phoenix Workforce\phoenix-workforce'
$env:GIT_TERMINAL_PROMPT = '0'

$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
$err   = Join-Path $env:TEMP 'phx-xlsx-fetch-stderr.txt'
try {
  # The repo path MUST be quoted here. Start-Process joins -ArgumentList with spaces and quotes
  # nothing, so an unquoted "F:\Phoenix Workforce\phoenix-workforce" reached git as two arguments
  # and it answered "fatal: cannot change to 'F:\Phoenix'" - rc=128, measured 2026-09-21 02:18.
  $p = Start-Process -FilePath 'git.exe' `
        -ArgumentList '-C', "`"$repo`"", 'fetch', '--quiet', 'origin', 'main' `
        -Wait -PassThru -WindowStyle Hidden -RedirectStandardError $err
  Add-Content -Path $log -Value ("FETCH {0} rc={1}" -f $stamp, $p.ExitCode)
  if ($p.ExitCode -ne 0 -and (Test-Path $err)) {
    # git's own words, which is the only thing that ever explains a failure here. Trimmed to four
    # lines so a repeating fault cannot flood the log the backup job shares.
    Get-Content $err -TotalCount 4 | Where-Object { $_.Trim() } | ForEach-Object {
      Add-Content -Path $log -Value ("FETCH        {0}" -f $_.Trim())
    }
  }
} catch {
  Add-Content -Path $log -Value ("FETCH {0} rc=host-error: {1}" -f $stamp, $_.Exception.Message)
}
exit 0
