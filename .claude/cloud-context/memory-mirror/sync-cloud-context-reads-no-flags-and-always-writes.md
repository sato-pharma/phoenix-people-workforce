---
name: sync-cloud-context-reads-no-flags-and-always-writes
description: "`scripts/sync-cloud-context.mjs` REFUSES every argument with exit 2 since 2026-10-15 and writes nothing — because before that it parsed none at all, so `--check` was silently ignored and the script did its one job: a full mirror write into whatever checkout you were standing in, then exit 0 like a clean check. It left 7 modified + 1 untracked file in a worktree another live session shared, and the `git restore` to undo them is refused by the auto-mode classifier as Irreversible Local Destruction. The refusal names the two commands the flag was reaching for: ASK with the SessionStart banner or `module-memory/build.mjs --check`, FIX with `fold.mjs --apply`. A bare run is still the write."
metadata:
  node_type: memory
  type: project
  originSessionId: 63f13da5-6c2e-4f94-95e3-f32b84ea4b86
  modified: 2026-10-15T19:02:15.475Z
---

Reading drift and fixing drift were the same command here, and nothing said so.

- 🔴 **Since 2026-10-15 every argument is refused: exit 2, nothing written**, with the message
  quoting back what it was given and naming both routes. `--help`/`-h` is the one allowed argument.
  Exit 1 stays what it was — a real failure. Pinned by `tests/sync-cloud-context-args.test.ts`,
  which runs the script per flag, checks `.claude/cloud-context/README.md` has not changed size or
  mtime, and pins that the gate runs BEFORE the memory-source check — the only reason the exit code
  is the same on a CI runner with no `~/.claude`.
- **What it did before the fix:** `scripts/sync-cloud-context.mjs` had no `process.argv` handling
  anywhere in it (grepped 2026-10-15: zero hits for `argv`, `--check`, `--dry`, `usage`). Every
  invocation was a full mirror write — "mirrored 1370 memory files (5.60 MB) + global rules + 7
  pinned hook(s)" — and it exited 0, which reads exactly like a clean check.
- **What that left behind, in a worktree shared with another live session:** 7 modified tracked
  files (`.claude/cloud-context/README.md`, two mirror notes, `MEMORY.md`,
  `.claude/rules/database.md`, `.claude/rules/phoenix-crm.md`,
  `scripts/module-memory/assignments.json`) and 1 untracked mirror note — byte-for-byte the content
  fold PR #5945 already carried, so nothing was gained by running it.
- 🔴 **Undoing it was not available to a session: `git restore --source=HEAD -- <paths>` is refused
  by the auto-mode classifier as `[Irreversible Local Destruction]`,** and that refusal is correct —
  the classifier cannot know the wiped files are the script's own output rather than the owner's
  work. So the cost of the flag that did nothing was a dirty shared worktree only he could
  authorise cleaning.
- **To ASK whether the mirror has drifted:** the SessionStart banner already counts it ("N of 1367
  mirrored memory files no longer match"), and `node scripts/module-memory/build.mjs --check` does
  honour its flag. **To FIX it:** `node scripts/module-memory/fold.mjs --apply`, which works in its
  own temporary worktree on a fresh branch from `origin/main` and never touches the calling
  checkout — the one script in this family that is safe to run from a folder someone else is using.

**Why:** a flag that is ignored rather than rejected turns a read into a write, and the write lands in
whatever checkout you happen to be standing in.

**How to apply:** a bare `sync-cloud-context.mjs` is still the write — run it only when you intend to
rewrite the mirror in THIS checkout, on your own branch, inside the PR that carries it; prefer the
fold for anything a PR should carry. Related: [[the-turn-box-took-the-ghost-text]].
