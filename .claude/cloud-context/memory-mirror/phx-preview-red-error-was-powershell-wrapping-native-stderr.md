---
name: phx-preview-red-error-was-powershell-wrapping-native-stderr
description: "phx-preview's red NativeCommandError was its OWN `2>$null` — PowerShell 5.1 wraps a native exe's stderr as ErrorRecords, so suppressing it there CREATES the noise; silence it on the remote side and give ssh LogLevel=ERROR."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-09T00:10:49.486Z
---

`phx-preview <branch>` printed four red lines — `cat: /home/phx/preview-state/3000.stopped: No such
file or directory` plus `NativeCommandError` — on its HAPPY path, 9 Oct 2026. The marker file is
absent whenever the last preview was not stopped for idleness, so `cat` writes to stderr, and the
script's own `2>$null` is what turned that into an error record instead of hiding it.

Fixed in `~/.claude/scripts/phx-preview.ps1`: the suppression moved into the remote command
(`cat … 2>/dev/null`, `tail -15 … 2>/dev/null`, `curl … 2>/dev/null`), the PowerShell-side `2>$null`
and `2>&1` were removed, and `-o LogLevel=ERROR` was added to `$SshOpts` so ssh's own
"Warning: Permanently added …" never reaches stderr either. Parse-checked, 0 syntax errors.

**Why:** in Windows PowerShell 5.1, redirecting a NATIVE executable's stderr wraps each line in an
ErrorRecord and sets `$?` to false even on exit code 0 — so the redirect that was meant to quiet a
harmless line is what makes it look like a failure, and a reader cannot tell it from a real one.

**How to apply:** in any PowerShell wrapper around `ssh`, `git`, `curl` or `node`, suppress or merge
stderr INSIDE the remote/native command, never with a PowerShell-side `2>$null` or `2>&1`. Related:
[[a-pipelines-status-is-the-last-stages]].
