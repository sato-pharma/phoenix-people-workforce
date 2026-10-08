---
name: a-new-crons-paperwork-trips-two-guards-nothing-warns-about
description: "A new cron's access-registry `reason:` is a NON-comment line, so the neutral-wording sweep reads it — and a new `.claude/rules/<module>.md` hook over 1,200 bytes must cite a `docs/*.md` file; both fail `validate` and neither is mentioned where the paperwork is written."
metadata:
  node_type: memory
  type: project
  originSessionId: 6591b3bf-083c-4444-bb06-41a2779e5795
  modified: 2026-10-08T01:48:43.428Z
---

Writing a new cron on 2026-10-08 (the Private Calendar gap notice, PR #5488) cost two CI-box runs on
paperwork, not on logic. Both are required-check failures, so they are cheap to find and free to avoid:

1. **`src/lib/security/access-registry.ts`'s `reason:` string is a NON-comment line**, so
   `tests/neutral-wording.test.ts` sweeps it like any screen string. A reason written the natural way —
   "telling him that Request review is how he answers it" — fails. Comments ARE out of scope and the
   owner settled that on 2026-10-05 ("leave the code comments as they are"), which is exactly why this
   surprises: the long prose right above it is exempt and the one string below it is not. Write the
   reason neutrally the first time; `them`/`their`/`the employee` all pass (the regex is
   `\b(?:he|his|him|himself)\b`).

2. **A new `## Rules` bullet in `.claude/rules/<module>.md` over 1,200 bytes must name a `docs/*.md`
   file** — `tests/agents-long-hooks-cite-docs.test.ts` holds module memory to the same standard as
   AGENTS.md §2/§4, which the file itself does not say. A rule bullet worth writing is almost always
   over 1,200 bytes, so plan on the pair: the account in `docs/` and the hook pointing at it.
   `DOCS_POINTER` is `docs/[A-Za-z0-9._-]+\.md`, bare prose or a link.

Measure the bullet the way the test does before pushing — `Buffer.byteLength(line, "utf8")` on the
single line, inside the `module-memory:rules:begin/end` markers.

Related: [[the-long-hook-guard-has-a-second-assertion-that-names-nothing]],
[[run-the-affected-tests-directly-instead-of-paying-a-ci-run-per-red]].
