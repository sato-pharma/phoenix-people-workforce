---
name: sync-cloud-context-reads-no-flags-and-always-writes
description: "`scripts/sync-cloud-context.mjs` PARSES NO ARGUMENTS AT ALL, so `--check`, `--dry-run` or any flag you invent is silently ignored and the script does its one job: it WRITES the whole mirror into the calling checkout. Measured 2026-10-15 — `--check` left 8 modified/untracked files in a worktree another session shares, and the `git restore` to undo them is refused by the auto-mode classifier as Irreversible Local Destruction. To ASK about drift, read the SessionStart banner or `node scripts/module-memory/build.mjs --check` (that one does take the flag); to FIX it, let the fold open its PR."
metadata:
  node_type: memory
  type: project
  originSessionId: 63f13da5-6c2e-4f94-95e3-f32b84ea4b86
  modified: 2026-10-15T18:12:26.930Z
---

Reading drift and fixing drift are the same command here, and nothing says so.

- 🔴 **`scripts/sync-cloud-context.mjs` has no `process.argv` handling anywhere in it** (grepped
  2026-10-15: zero hits for `argv`, `--check`, `--dry`, `usage`). Every invocation is a full mirror
  write — "mirrored 1370 memory files (5.60 MB) + global rules + 7 pinned hook(s)" — and it exits 0,
  which reads exactly like a clean check.
- **What it left behind, in a worktree shared with another live session:** 7 modified tracked files
  (`.claude/cloud-context/README.md`, two mirror notes, `MEMORY.md`, `.claude/rules/database.md`,
  `.claude/rules/phoenix-crm.md`, `scripts/module-memory/assignments.json`) and 1 untracked mirror
  note — byte-for-byte the content fold PR #5945 already carried, so nothing was gained by running it.
- 🔴 **Undoing it is not available to a session: `git restore --source=HEAD -- <paths>` is refused by
  the auto-mode classifier as `[Irreversible Local Destruction]`,** and that refusal is correct — the
  classifier cannot know the wiped files are the script's own output rather than the owner's work. So
  the cost of the flag that did nothing is a dirty shared worktree that only he can authorise cleaning.
- **To ASK whether the mirror has drifted:** the SessionStart banner already counts it ("N of 1367
  mirrored memory files no longer match"), and `node scripts/module-memory/build.mjs --check` does
  honour its flag. **To FIX it:** `node scripts/module-memory/fold.mjs --apply`, which works in its own
  temporary worktree on a fresh branch from `origin/main` and never touches the calling checkout —
  the one script in this family that is safe to run from a folder someone else is using.

**Why:** a flag that is ignored rather than rejected turns a read into a write, and the write lands in
whatever checkout you happen to be standing in.

**How to apply:** never pass a flag to `sync-cloud-context.mjs` expecting a dry run; run it only when
you intend to rewrite the mirror in THIS checkout, and prefer the fold for anything a PR should carry.
Related: [[the-turn-box-took-the-ghost-text]].
