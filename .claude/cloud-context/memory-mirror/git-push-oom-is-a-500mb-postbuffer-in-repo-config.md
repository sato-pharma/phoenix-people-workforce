---
name: git-push-oom-is-a-500mb-postbuffer-in-repo-config
description: "git push dies with a 500MB malloc failure because http.postBuffer is pinned to 500m in .git/config; the retry then lies and says the token is invalid"
metadata:
  type: reference
---

`http.postBuffer = 524288000` (500 MB) is set in `F:/Phoenix Workforce/phoenix-workforce/.git/config`.
Every worktree shares it, because they all point at that one git dir.

When the machine's **commit charge** is near its ceiling, any `git push` — even a one-line,
one-file change — dies before it sends a byte:

```
fatal: Out of memory, malloc failed (tried to allocate 524288000 bytes)
send-pack: unexpected disconnect while reading sideband packet
```

**Why:** Do not read this as a network problem or a big-push problem. Git allocates that whole
buffer up front. Confirm with `git config --show-origin --get-all http.postBuffer` — it is a
committed local setting, not a default.

**The retry lies.** Once commit charge is exhausted, `fork()` starts failing with `0xC0000142`
(see [[turbopack-500s-with-0xc0000142-when-commit-is-full]]), the `gh auth git-credential` helper
crashes before it can answer, and git reports:

```
remote: Invalid username or token. Password authentication is not supported for Git operations.
```

That is **not** an auth failure and the token is fine. Do not re-authenticate, do not touch
`gh auth`, do not regenerate anything.

**How to apply:** Override it for the one push instead of editing the shared config, which a
parallel session also reads:

```
git -c http.postBuffer=8388608 -c pack.threads=1 push origin <branch>
```

Then check the real ceiling before blaming git — `FreePhysicalMemory` can look fine while commit
is the thing that is full:

```
(Get-CimInstance Win32_OperatingSystem) | % { "{0} GB of {1} GB" -f [math]::Round(($_.TotalVirtualMemorySize-$_.FreeVirtualMemory)/1MB,1), [math]::Round($_.TotalVirtualMemorySize/1MB,1) }
```

Measured 2026-08-22: 971 MB RAM free but **30.1 GB of 31.8 GB commit used**, with 8 sessions live.
Related: [[laptop-m17r2-ram-soldered-16gb-ceiling]], [[git-push-to-origin-hangs-retry-immediately]].

## FIXED 2026-08-23 — the owner said fix it, so the config is fixed. Do NOT re-raise it.

The advice above — *"override it for the one push instead of editing the shared config"* — was a
workaround, and the owner overruled it: **`fix the postBuffer`**. Done.

```
F:/Phoenix Workforce/phoenix-workforce/.git/config   http.postbuffer: 524288000 -> 8388608
```

Backup of the pre-change file: `.git/config.bak-postbuffer-20260823`. Reverting is a one-liner if it
is ever needed, but see the warning below before doing that.

**Verified, not assumed.** Plain `git fetch`, `git ls-remote`, and `git push` all exited **0** with **no
`-c` override** afterwards. It was the only `http.*` key set, and it is set in exactly one scope
(`--local`); `--system`, `--global` and `--worktree` are all unset.

**Honest limit of that proof: RAM had recovered to 3.21 GB by test time, against 0.74 GB when it
failed.** So the test shows the new value works; it does **not** reproduce the failure. The reason to
believe the fix is structural rather than empirical — git allocates the whole buffer up front, so a
62x smaller allocation simply cannot hit the ceiling that a 500MB one did.

**How to apply.**
- **Never restore 524288000.** That number is cargo-culted from "RPC failed / curl 55" advice and is
  what caused this. If a genuine large-push failure ever appears, raise to **50MB at most** and
  investigate chunked transfer first.
- **The key is stored lowercase as `http.postbuffer`.** Writing `git config --local http.postBuffer <v>`
  updates that same entry in place — confirmed no duplicate key was left behind. Check with
  `git config --local --get-regexp '^http\.'` after any change.
- **`extensions.worktreeConfig` is `true` in this repo**, so a worktree *could* carry its own value —
  but `postBuffer` lives in the shared `--local` config and every worktree inherits it. Verified by
  reading the effective value from each worktree, not by assuming.
- **A no-op `git push` on a squash-merged branch RECREATES the deleted remote branch.** Testing the fix
  with `git push origin <merged-branch>` printed `* [new branch]` and put it back on GitHub; it had to
  be deleted again. Test with `fetch`/`ls-remote`, or clean up after.
- `AGENTS.md` §2.1 carried the old "a push OOM is a 500MB postBuffer" wording; corrected the same day so
  a session does not go hunting for a setting that is no longer there.
