---
name: phx-backup-disaster-recovery-set
description: "F:\\PHX backup is the disaster-recovery set built 2026-08-26 - what is in it, where the copies are, and the core.longpaths trap that makes a git-bundle restore silently return zero refs on Windows"
metadata:
  type: project
---

`F:\PHX backup` (7.72 GB, 237k files) is the disaster-recovery set, built 2026-08-26 when the owner
asked what a PC reset would cost. **Phoenix's cloud side is not at risk** — Railway, Supabase and
GitHub are untouched by a reset. The set exists for the *local support layer*, which is the only part
that is irreplaceable.

Nine sections; the ones that cannot be re-derived are `01-claude-memory`, `04-repo-secrets`
(every `.env*`, none of them in git), `06-git`, `07-scheduled-tasks` and `08-attendance-agent`.

**Copies, 2026-08-26:** `F:\PHX backup` raw · `G:\` USB (SHA256-verified) · Google Drive as an
encrypted 7-Zip (`-mhe=on`) built by `F:\PHX backup\MAKE-GOOGLE-DRIVE-BACKUP.ps1`, on the
`phoenixx.oag@gmail.com` account.

## The restore trap: a bundle restore silently returns ZERO refs

`06-git\phoenix-ALL-REFS.bundle` holds **323 refs**. Restoring it on Windows with the obvious
command gives **0 refs**, with the objects transferred fine and no useful error:

```
git init restored && cd restored
git config core.longpaths true          # <-- WITHOUT THIS LINE: 0 refs restored
git fetch "F:\PHX backup\06-git\phoenix-ALL-REFS.bundle" refs/*:refs/*
```

Codex CLI writes `refs/codex/turn-diffs/checkpoints/<64hex>/<64hex>/<ms>/<uuid>` refs whose loose-ref
paths run past Windows' 260-char limit. Git copies every object in, then fails on the first such ref
and **rolls the entire ref batch back** — so the bundle looks corrupt when it is perfect.
Measured 2026-08-26: without the flag **0**, with it **315** (315 not 323 because 8 entries are
`worktrees/*/HEAD`, which are not under `refs/` and are correctly skipped).

Same failure family as the glob in [[deleted-branch-tips-live-in-refs-deleted-branches]] that reads
0 — a check that returns a confident, plausible, wrong number.

## Two verification traps hit while building it

- **`git cat-file -e <sha>^{commit}` reports a PRESENT object as missing** when the object is a tree
  or a tag. One "missing object" in an audit was a tree that was there all along. Peel only when you
  know the type; otherwise use bare `git cat-file -e <sha>`.
- **A rebuilt bundle is not automatically a superset of the old one.** Rebuilding on 2026-08-26
  produced *fewer* refs (280 vs 307) because other sessions had run `git remote prune origin` and
  deleted branches in between. Diff the two by **tip SHA**, not ref name, and remember a tip that
  is an ancestor of `origin/main` is still contained even though it is no longer a tip. The 43
  pruned-away refs were re-created under `refs/archive/v1/*` so the rebuild became a true superset.

**Why:** the owner asked for a set that loses nothing, so a restore path that fails silently is the
one defect that would matter, and it would only be discovered on the day it is needed.

**How to apply:** never call a backup done without performing the restore. And when a restore
returns an implausible zero, suspect the write path, not the archive.

⚠ **`09-claude-transcripts`, `04-repo-secrets` and `03-user-config` hold live credentials** — the
production Supabase service-role key, `ghp_`/`gho_` tokens, `sk-proj-` keys and SSH keys. Never
upload, sync or share those three unencrypted. `01-claude-memory` and `02-claude-config` were
scanned clean.

Related: [[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]] ·
[[git-push-oom-is-a-500mb-postbuffer-in-repo-config]]
