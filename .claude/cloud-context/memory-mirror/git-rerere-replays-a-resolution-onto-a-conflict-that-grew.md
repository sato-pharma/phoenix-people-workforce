---
name: git-rerere-replays-a-resolution-onto-a-conflict-that-grew
description: "git rerere replayed a two-block run-tests.ts resolution onto a merge where a third PR had added a third block, which put two registrations inside ONE await runTest(...) call — TS2554 in `checks` and 'FAIL test wiring is complete' in `validate`, while every line-presence check reads clean; after a rerere-assisted merge of that file check the call STRUCTURE, not the lines."
metadata:
  node_type: memory
  type: project
---

Resolving a `tests/run-tests.ts` conflict by keeping both sides is right at the line level and wrong
at the call level: each registration is `await runTest("<title>", runXTests);`, so concatenating two
sides produces **one call with four arguments**. Only the first function runs; the second is a dead
argument, and every check that looks for its name or its title still finds both.

**Measured 2026-10-09 on PR #5683.** `checks` failed with
`tests/run-tests.ts(9476,3): error TS2554: Expected 2 arguments, but got 4`, and `validate` failed
with `FAIL test wiring is complete (no test file imported-but-uninvoked, none orphaned)` —
`tests/test-wiring-complete.test.ts` says it in words: *"one or more `await runTest(...)` calls pass
MORE THAN ONE test function. Only the first runs; the rest are silently retired… This is what a merge
conflict at the shared append anchor produces when both sides are kept."* Two red CI runs.

🔴 **`git rerere` IS THE MECHANISM, AND IT WILL DO IT AGAIN** (the peer session that hit the other
half of it, same evening): it replays an earlier two-block resolution onto a later merge where a
third PR has added a third block, so the merge looks resolved and nobody chose anything. The repo
records a resolution on every conflicted merge of this file (`Recorded preimage` / `Recorded
resolution` in the merge output), so the next similar merge is pre-resolved by default.

**How to apply:** after ANY rerere-assisted merge of `tests/run-tests.ts`, check the STRUCTURE before
pushing — `grep -c "await runTest(" tests/run-tests.ts` against `main` (expect exactly +1 per added
test), and assert no `run*Tests,` line is followed directly by a quoted line. The complete check,
which is what proved the fix: every `await runTest(\n … \n);` block must contain exactly ONE line
matching `^\s+run\w+,$` — 1,234 calls, 0 bad. Running the suites file-by-file CANNOT see this: a
runner that imports each test file's exported `run*` function never loads `run-tests.ts` at all.
