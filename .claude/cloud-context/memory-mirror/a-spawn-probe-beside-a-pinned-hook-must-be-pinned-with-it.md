---
name: a-spawn-probe-beside-a-pinned-hook-must-be-pinned-with-it
description: A helper added next to a mirrored ~/.claude hook breaks CI silently unless it joins PINNED_HOOKS — the selftest resolves it as a sibling, and a runner has no ~/.claude at all.
metadata:
  type: project
---

`scripts/sync-cloud-context.mjs` mirrors a handful of `~/.claude/hooks/*.mjs` into
`.claude/cloud-context/laptop-hooks/` so a repo test can run a guard that does not live in git. On
2026-10-09 `memory-guard.mjs` gained selftest cases that load a **sibling** `spawn-probe.mjs` with
`--import`, to prove the hook starts no subprocess on a session start. The probe was never added to
`PINNED_HOOKS`, so the mirrored guard looked for a file that is not in the repo — and a CI runner has
no `~/.claude` to fall back on. `ERR_MODULE_NOT_FOUND`, one failed case, and `validate` red on the
09:00 Cairo memory-fold PR (#5634) at `tests/memory-guard-pin.test.ts:105`, `1 !== 0`.

**Why:** the laptop passes (25 cases, 0 failed) because the sibling is right there, so the break is
invisible until a fold or any other re-sync carries the new guard into CI — and it then lands on a
generated PR nobody wrote, which is the worst place to debug it.

**How to apply:** add a helper to `PINNED_HOOKS` in the same change that makes a pinned hook depend
on it, then `node scripts/sync-cloud-context.mjs` (it also rewrites the mirror README's hook list, so
hand-copying the file alone leaves the README wrong). A probe is safe for CI when it no-ops without
its env variable. A red `validate` on a memory or fold PR is the session's to fix and ship — never
put to him. See [[running-a-phoenix-test-file-directly-runs-nothing]].
