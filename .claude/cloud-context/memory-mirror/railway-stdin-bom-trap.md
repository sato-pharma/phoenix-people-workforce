---
name: railway-stdin-bom-trap
description: "railway variable set --stdin on Windows stores a UTF-8 BOM in front of the value, and PowerShell's -ceq gives U+FEFF zero collation weight so the read-back check passes anyway"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 2660f573-67f5-4949-b3d2-31bccf171402
  modified: 2026-08-14T15:36:54.947Z
---

Cost 17 minutes of **every production cron 401ing** on 2026-08-14, rotating `CRON_SECRET`.

**Half one — the write corrupts the value.** `railway variable set KEY --stdin` through the Windows
npm shim (`C:\Users\satoh\AppData\Roaming\npm\railway.ps1` / `.cmd`) stores `U+FEFF` + the value.
Reproduced four ways — a `StreamWriter` on `[Text.Encoding]::UTF8`, raw ASCII bytes to
`StandardInput.BaseStream`, a PowerShell native pipeline with `[Console]::OutputEncoding` set to
`UTF8Encoding($false)`, and a `StreamWriter` explicitly built with `UTF8Encoding($false)`. **All four
stored the BOM.** It is not your encoder — do not keep trying to out-encode it.

The form that writes clean is positional:

```
railway variable set "KEY=$value" --skip-deploys -e production -s phoenix-people-workforce
```

Proven with a throwaway `PHX_ROTATION_PROBE`: `--stdin` → length 17 for a 16-char value, first char
code 65279; `KEY=VALUE` → length 16, first char code 97. Trade-off: the value sits on the process
command line, so build it from a variable and never let it reach a transcript. Note
`variable delete` has **no `--skip-deploys`** — deleting a key triggers a deploy.

**Half two — the obvious check cannot see it.** PowerShell's `-ceq` on strings is a *linguistic*
comparison, and .NET gives `U+FEFF` zero collation weight. So:

```powershell
"$([char]0xFEFF)abc" -ceq "abc"     # True.  Length is 4 vs 3.
```

A read-back that reported `length 65` and `EXACT match True` in the same breath was not a glitch —
`-ceq` was answering a different question. **Verify a secret by `.Length`, a `-cmatch` anchored
regex, and a sha256 fingerprint registered *before* the write.** Never by `-eq`/`-ceq`. Use
`[string]::Equals($a,$b,[System.StringComparison]::Ordinal)` when you do need an equality test.

**Half three — `[0]` on a pipeline that matched once returns a CHARACTER.** Same session, same file,
different false reading:

```powershell
$k = ($lines | Where-Object { $_ -match '^CRONJOB_API_KEY=' })[0]   # -> "C"
$k = @($lines | Where-Object { $_ -match '^CRONJOB_API_KEY=' })[0]  # -> the whole line
```

`Where-Object` returns a scalar when exactly one item matches, and indexing a string yields a char.
The 44-char key read back as `"C"`, hashed to `6B23C0D5F35D1B11`, and 401'd against the API — which
read as "the key was deleted" and sent the owner re-issuing a key that was never broken. **Always
`@()`-wrap a pipeline before indexing it**, and when a credential suddenly looks wrong, re-read it
with different parsing code before believing the credential changed.

**Why it reached production.** The variable was set with `--skip-deploys`, so the running app kept
the old secret and nothing broke — correct. Then *another session* merged PR #2135, and a Railway
deploy **injects whatever the variables hold at deploy time**, so the BOM value went live at 17:51
Cairo while all 12 cron-job.org jobs still sent the old one. A BOM cannot survive an HTTP
`Authorization` header, so every job 401'd. **A staged `--skip-deploys` variable is only safe until
somebody else merges** — in a repo where merge-to-`main` ships instantly and sessions run in
parallel, treat the staging window as minutes, not hours, and verify the value before staging it.

Related: [[railway-merge-is-the-production-deploy]],
[[railway-deploy-applies-no-migrations]], [[two-sessions-fixed-one-bug-main-was-never-ci-validated]].
