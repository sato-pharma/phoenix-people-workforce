---
name: prove-a-husks-junction-is-not-load-bearing-before-deleting-it
description: "Before deleting a worktree husk whose only content is a `node_modules` junction, scan the PRIMARY's package links for that folder's name and assert `broken=0` — an entry count proves nothing, and on 2026-10-09 a husk deletion dangled all 68 links."
metadata:
  node_type: memory
  type: project
  originSessionId: ce4db4f1-62c2-4246-a60d-28811d782e5f
  modified: 2026-10-09T13:38:39.126Z
---

**The positive test, before removing any `node_modules` junction left behind by a retired
worktree.** Two reads, both from the primary's `node_modules`:

1. **Does anything route through it?** Walk every top-level entry *and* every `@scope/*` child,
   `fs.lstatSync` each, and for the symlinks read `fs.readlinkSync` and match the husk's folder name
   against the TARGET. `0` hits is the only safe verdict. On 2026-10-09 the same scan returned **68
   hits** for `_wt-reconcile-deductions` — see [[the-retired-reconcile-deductions-folder-is-load-bearing]].
2. **Is anything dangling now?** Count symlinks where `fs.existsSync` is false. Expect `broken=0`
   both before and after the removal.

🔴 **An entry count is not evidence.** `readdirSync(node_modules).length` and the `.pnpm` directory
count are **identical before and after** the junction disappears — 64 and 1,000 here — because the
links themselves survive and only their targets go. A session deleted the folder on 2026-10-09 after
reporting "64 / 1,000 unchanged, nothing was followed", and all 68 links were dangling for the ~2
minutes until another session recreated the junction. `require.resolve` is a sharper probe, but only
on real dependencies: `xlsx` and `tsx` are NOT in this repo's `package.json`, so their
`MODULE_NOT_FOUND` is a bad test pick, not damage.

**How to apply:** removing the link itself is safe only once step 1 returns 0. Remove it with
`fs.rmdirSync(<link>)` (falling back to `unlinkSync`) after asserting `lstat().isSymbolicLink()` —
never `rm -rf` the folder, which can follow a Windows junction into the real tree — then `rmdirSync`
the folder only if `readdirSync` is empty, and re-run step 2. `.claude/worktrees/index-prodplan-fks-20261009` and
`advisor-baseline-triage-20261009` each passed with 0 hits and were cleared this way on 2026-10-09;
`_wt-reconcile-deductions` failed it at 16:14 and passed at 16:26, once its 68 links had been
re-pointed at the primary's own `.pnpm` — the test is the gate, never the folder's name.

🔴 **`repo-doctor` RUNS STEP 1 ITSELF SINCE PR 5672** — `scripts/repo-doctor-load-bearing.mjs` reads
the primary's link TARGETS (scoped children and already-dangling links included) and the report
diverts such a folder into a `LOAD-BEARING` section before the husk test, so `--fix`, `--strip-idle`
and `new-session.mjs --remove` can no longer offer one. Run this scan by hand only for a junction
you are removing outside those tools.
