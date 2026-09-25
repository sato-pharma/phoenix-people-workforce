---
name: an-interrupted-session-leaves-the-tree-deliberately-broken
description: "AGENTS.md requires breaking a fix to prove its new test fires, so an interrupted session leaves the working tree deliberately broken with BREAK- markers — grep for them before acting on \"commit it\"."
metadata:
  type: feedback
---

**Before committing anyone else's uncommitted work, `git grep -n "BREAK-" -- src tests` first.**

This repo's own rule (AGENTS.md §2) is that *"a regression test only counts if you break the fix and
confirm the new test's own headline assertion fires."* Following it means the tree spends a few
minutes in a state that is **broken on purpose**. If the session is interrupted in that window — and
on this laptop it is interrupted by hard freezes — the mutation is what the next session inherits.

**Why:** on 2026-08-26 the owner said "commit it" for finished-looking Monthly Closing work: 11
modified files, 3 untracked, a clean-looking `git status`. Three lines carried `// BREAK-3a`,
`// BREAK-3b`, `// BREAK-3c` and had been reverted to the pre-fix behaviour. `lineHasOfficeChannel`
was imported in two files and called in neither — an unused import, which alone fails the **required
`lint` check** — and `tests/office-column-is-cns-only.test.ts` pins the source with
`source.includes("lineHasOfficeChannel(matrix.line)")`, so `validate` would have failed too.
Committing on trust would have pushed a red PR of deliberately-sabotaged code with a message
claiming the opposite.

**How to apply:**

1. **Grep for the marker before staging** — `BREAK-`, and also `TODO|FIXME|XXX|HACK|debugger|
   console\.log|\.only\(|\.skip\(` across the diff *and* the untracked files. `git diff` alone
   misses untracked ones entirely, which is where two of the three new files lived.
2. **A test that pins source text tells you the intended code verbatim.** Do not guess the
   restoration — `office-column-is-cns-only.test.ts` stated both halves: the source must contain
   `lineHasOfficeChannel(matrix.line)` and must NOT match `/buildOfficeLookup\(\s*office\s*\)/`.
   Read the test, then write the line it demands.
3. **Then prove it.** CI is the gate here and a full local run is banned, but restoring three lines
   of someone else's in-progress reasoning is a reconstruction, not a rubber stamp. Run the affected
   suites only: a throwaway entry file that imports the handful of `run…Tests` exports and calls
   them, invoked as `node --experimental-strip-types --experimental-loader ./tests/alias-loader.mjs`
   (the same flags `package.json`'s `test` script uses — never `pnpm run test`, which purges
   `node_modules`). Seconds, almost no RAM, and it is not the "local full validation" §7 forbids.
   **Delete the runner before staging.**

Related: [[commit-limit-not-ram-is-the-freeze-ceiling-pagefile-now-16gb]] is why a session here gets
interrupted mid-mutation in the first place.
