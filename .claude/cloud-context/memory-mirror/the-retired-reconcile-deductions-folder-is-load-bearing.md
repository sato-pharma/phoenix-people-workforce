---
name: the-retired-reconcile-deductions-folder-is-load-bearing
description: "`_wt-reconcile-deductions` held the primary's 68 package links together through its lone junction and was deleted three times on 2026-10-09 — OVER: the primary was re-pointed and the folder is gone (68 links, 0 broken, measured after the removal); the durable lesson is that a zero-file folder can be load-bearing, which repo-doctor proves itself since PR 5672."
metadata:
  node_type: memory
  type: project
  originSessionId: 5566e73c-38c0-4e93-b3c8-7857c2ef20ff
  modified: 2026-10-09T13:38:44.437Z
---

🔴 **THIS CONDITION IS OVER AND THE FOLDER IS GONE — keep this note for the trap shape, never as a
live do-not-delete.** Measured in the primary's own `node_modules` at **16:47 and again at 16:52
Cairo on 2026-10-09**, the second time after the folder had been removed: 68 top-level package links,
**0 routed through `_wt-reconcile-deductions`, 0 broken**, `@supabase/supabase-js` resolving inside
the primary's own `.pnpm` (still 1,000 package directories) and `require.resolve('react')` answering.
The primary was re-pointed first, which is exactly what made the removal safe.

**What it was, from 2026-10-09 morning until the primary was re-pointed mid-afternoon** (0 hits by
**16:26 Cairo** per [[prove-a-husks-junction-is-not-load-bearing-before-deleting-it]]; a report of
mine still read 68 links through it minutes earlier). The worktree was retired and the folder held
exactly one entry: a junction `node_modules` → `F:\Phoenix Workforce\phoenix-workforce\node_modules`.
A `pnpm run` executed INSIDE that worktree had rewritten the PRIMARY's 68 top-level package links to
absolute paths routed through the worktree — e.g. `node_modules/@supabase/supabase-js` →
`_wt-reconcile-deductions/node_modules/.pnpm/@supabase+supabase-js@2.112.4_.../node_modules/@supabase/supabase-js`
— which resolve only while that junction stands, travelling through it back into the primary's own
`.pnpm`. Nothing was ever lost; removing the folder dangled all 68 links at once, in the primary and
in every worktree junctioned into it. It was deleted **three times in one day** by three separate
sessions' `repo:doctor --fix`, and the junction recreated each time (68 dangling → 0 with no
reinstall). The owner's decision while it stood was *"leave it on the junction repair for now"*.

🔴 **THE DURABLE LESSON, and it is now mechanical.** A zero-file folder can be load-bearing: a
junction is a LINK, not a file, so `HUSKS (… ZERO files — safe to delete)` was honest and wrong.
Since **PR 5672** `repo-doctor` asks the question itself — `scripts/repo-doctor-load-bearing.mjs`
reads the primary's own link TARGETS and diverts such a folder into a `LOAD-BEARING` section BEFORE
the husk test, `--fix` re-proves it from a fresh read before each delete, `--strip-idle` refuses such
a worktree, and `new-session.mjs --remove` neither unlinks the junction nor prints `rmdir /s /q` for
it. Pinned by `tests/repo-doctor-load-bearing.test.ts`. The check is by PROOF, never by name — the
next worktree retired after a stray `pnpm run` is load-bearing under a different name.

**How to apply:** if imports fail across sessions with `ERR_MODULE_NOT_FOUND` for a package that is
plainly installed, read the primary's link TARGETS before suspecting anything else — a top-level
`ls node_modules` count looks perfectly healthy while every target is missing, which is how two
reports of "node_modules intact, 58 entries" were wrong on the day. The positive test to run before
removing any such junction by hand is
[[prove-a-husks-junction-is-not-load-bearing-before-deleting-it]].
