---
name: the-claude-scripts-live-off-machine-on-a-never-merge-branch
description: "The laptop's ~/.claude scripts and hooks are backed up OFF the machine hourly to the branch laptop/claude-scripts of phoenix-people-workforce (54 source files, ~750 KB) by ~/.claude/scripts/claude-scripts-backup.mjs - NEVER merge that branch and never open a PR from it; it is pure git plumbing so it touches no working tree, branch or index, a side branch runs no workflow and bills no Actions minutes, and a secret-shape and NUL gate refuses the push rather than filtering the file."
metadata:
  node_type: memory
  type: project
  originSessionId: 1baaa0f5-9436-457f-8907-da9439516d28
  modified: 2026-10-04T05:49:12.190Z
---

Built 2026-10-04, because C: and F: are two partitions of **one** NVMe
([[there-is-only-one-disk-so-no-local-backup-covers-a-disk-failure]]), so every local archive on
this box — `F:\PHX backup`, the hourly `xlsx/` copy, the scratchpad archive, the worktree snapshot —
dies with the disk. **A push is the only off-machine copy there is**, and `~/.claude` holds the
hooks and scripts that make this machine behave the way it does: they were the one layer with no
copy anywhere.

```
node ~/.claude/scripts/claude-scripts-backup.mjs            # hourly, 00:35
node ~/.claude/scripts/claude-scripts-backup.mjs --dry-run   # the gate only, pushes nothing
```

🔴 **NEVER MERGE `laptop/claude-scripts`, AND NEVER OPEN A PR FROM IT.** It is a storage location
that happens to be reachable by git, not a contribution: merging it would put 750 KB of laptop-only
PowerShell into `main`, every worktree and every cloud clone. It is also why the destination is a
branch rather than a folder on `main` — `ci.yml` triggers on `pull_request` and `push: branches:
[main]` only, and every other workflow is schedule, dispatch or path-filtered on `main`, so **a push
to this branch runs no workflow and bills no Actions minutes** (read from the workflow triggers, not
assumed).

**It touches nothing.** Blobs via `git hash-object -w`, a temp index through `GIT_INDEX_FILE`,
`write-tree`, `commit-tree`, then `push origin <commit>:refs/heads/<branch>` — no checkout, no
branch switch, no stash, no `git init`. That matters because eight sessions share the primary
checkout.

**What deliberately does NOT travel:** `.log` files and the `xlsx-tripwire-procs-*.txt` dumps (they
hold full process command lines, exactly where a token ends up), **`.json` of any kind**
(`settings.json`, `.credentials.json` and MCP caches all live under `~/.claude`, and a glob is a bad
place to be approximately right), and `~/.claude/CLAUDE.md` plus the memory folder — those are
already mirrored into `main` by `scripts/sync-cloud-context.mjs`.

🔴 **THE GATE REFUSES THE PUSH; IT NEVER FILTERS THE FILE.** `SECRET_SHAPES` matches real shapes —
JWT, `sk-`, `gh[pousr]_`, `github_pat_`, `sbp_`, `xox[baprs]-`, `AKIA`, `AIza`, `re_`, a postgres
URL carrying a password, a PEM private key header — not a generic `/key|token/`, and it fails
**closed**: one match and nothing is pushed. The refusal names the file and the shape and **never
the value**. Broken-and-watched on the real script, not a copy: a JWT-shaped string and a NUL byte
each make it refuse, and it clears when they are removed.

**Two defects the first scheduled run exposed, both fixed and verified:**

- The README/MANIFEST it writes embedded a timestamp, which made the tree a function of the clock —
  so "unchanged → push nothing" could never fire. The time lives in the commit message only now;
  verified push → no-push on an unchanged hour → push after touching a source file.
- A push was rejected with **no reason line at all**, between two manual pushes of identical content
  that both succeeded. There is now one retry that re-reads the remote tip first — and it is
  load-bearing: the rejection recurred on the next run and the retry carried it.

**Verify it actually left the machine** by reading files back through GitHub's contents API and
comparing sha256, not by trusting the push's own output.

🔴 **BUT NORMALISE THE LINE ENDINGS BEFORE YOU BELIEVE A MISMATCH.** `git hash-object` applies the
repo's text normalisation, so a CRLF file on this disk is stored LF and a raw sha256 of the two
**always** differs — three scripts read MISMATCH on 2026-10-04 with byte-identical content, and the
LF-normalised hashes equalled the remote exactly. Compare
`sha256(local.replace(CRLF, LF))` against the blob. (A BOM-less UTF-8 `.ps1` is fine here: the only
non-ASCII in either watcher is the 🔴 marker, and it is in comments, never in a string literal.)

**A failure is alarmed**, hourly at :55 — `Phoenix Claude Scripts Backup - Failure Alert` runs
`~/.claude/scripts/claude-scripts-backup-watch.ps1`, five lines of `PHX_WS_*` that point the shared
`worktree-snapshot-watch.ps1` at this backup. One watcher serves every backup task on this box, so a
fix to the logic is made once; read
[[get-scheduledtaskinfo-without-taskpath-can-return-null-and-read-as-healthy]] before trusting
either signal it reads. Related: [[uncommitted-worktree-work-is-snapshotted-hourly]].
