---
name: run-the-affected-tests-directly-instead-of-paying-a-ci-run-per-red
description: A branch that adds a count, an event type or a union member breaks SEVERAL exactly-pinned lists, and the suite stops at the first throw — so one CI run reveals one of them; import the affected test files' own run* functions in ONE small node process instead, and NEVER hand-prune the `git grep -l` list, because the file you drop as unrelated is the one that goes red.
metadata:
  type: project
---

Measured 2026-10-08 on `codex/crm-plan-gaps` (PR #5466, carried by roll-up #5470): six separate reds,
each a different pinned list the new work made stale — neutral wording, two event-type rosters, a
policy row, a `.eq("is_test", false)` count of 3 that had to be 4, an in-app-only roster of 6 that had
to be 7, and a 1,689-byte module-memory bullet with no `docs/` pointer. `run-tests.ts` rethrows at the
first failure, so **each CI run named exactly one of them** — four runs, ~56 billable minutes, before
the pattern was obvious.

The cheap read: a scratch `.mjs` that imports each affected test file by absolute URL and calls its
exported `run*Tests()`, run with the harness's own flags —
`node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs`.
The static tests only `readFileSync` source and compare strings, so 44 of them ran in seconds and well
under the memory-watchdog floor, where the whole suite does not fit on this box at all. Import with
`new URL(\`tests/${file}.test.ts\`, pathToFileURL(process.cwd() + "/"))` — a relative `./tests/...`
resolves against the SCRATCH file's folder, not the repo.

Find the files to run with `git grep -l <changed-file-path> -- tests/` — one grep per CHANGED FILE
PATH, and **that list is the blast radius: do not hand-prune it.**

🔴 **Pruning it is what cost the next red** (2026-10-08, PR #5491). A keyword search returned 48
candidate files; 36 of them looked related to email and were run, all green; `validate` then failed
on `tests/phoenix-crm-first-visit.test.ts`, one of the twelve dropped as "not about email". Its
name says Phoenix CRM, and what it pins is a line of `send-phoenix-email.ts` —
`const alwaysBcc = ADMIN_STANDING_EMAIL;` — because the standing admin copy is what makes that CRM
notice reach the owner. A REFACTOR of a shared file is pinned from wherever the behaviour matters to
somebody, under a name that has nothing to do with your change, so **the file's own name carries no
information about whether it will go red.** The path grep knows; judgement does not.

Same branch, same day: extracting three inline lines into `withStandingAdminBcc` was right — a rule
in a function can be executed by a test, where three lines in a 600-line send path can only be read
— but every existing source-pattern pin on those lines breaks, and re-pointing one is part of the
change, not an accident.

Two shapes this caught that neither `tsc` nor a green run would: a source slice taken BACKWARDS
(`indexOf(fn)` to a type declared ABOVE it) is the empty string, so every assertion in that block
fails for the wrong reason; and a guard whose first parameter is the MODULE, called with one argument,
type-checks because the second is optional and then answers about a module that does not exist.
