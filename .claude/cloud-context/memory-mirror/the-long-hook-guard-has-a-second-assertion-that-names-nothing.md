---
name: the-long-hook-guard-has-a-second-assertion-that-names-nothing
description: "tests/agents-long-hooks-cite-docs has TWO assertions — the first lists every rule bullet over 1,200 bytes citing no docs/ file, the second asserts fewer than a tenth of all hooks are long and prints only `false !== true`. Adding a docs/ pointer to your own long rule clears the red you read and leaves the red you did not; bring the bullet UNDER 1,200 instead (relocate the account to docs/ first, trim second). The suite also STOPS at the first throwing test, so one FAIL has told you about a prefix of it, never all of it."
metadata:
  node_type: memory
  type: project
  originSessionId: d96338c4-b2ab-41ed-aa4e-ed85e9af64ce
  modified: 2026-10-05T21:43:20.066Z
---

Measured 2026-10-06 on `codex/crm-accuracy-gate`. Two new Phoenix CRM rule bullets (the
coarse-location gate and the customer name fold) were each over 1,200 bytes and named no `docs/`
file, so the box refused the head on assertion one. Appending
`Account: docs/agents-owner-rules.md, "<heading>"` to each silenced that list — and assertion two
then failed on its own: **29 long hooks of 285, cap 28.5**, where `main` had been green at 27 of 283.
So the two bullets a session adds are the entire difference, and the ratio is invisible until the
named-offender assertion stops throwing.

The cure that holds: write the account into `docs/agents-owner-rules.md` (CRM, payroll, sales,
recruitment and exports all go there), then trim the bullet to the cue plus the pointer and check the
byte count — 2,021 → 1,087 and 1,891 → 1,067 here. **Relocate first, trim second**, which the guard's
own failure message insists on because the reverse destroys evidence that exists nowhere else.

🔴 **`tests/run-tests.ts` stops at the first test that throws**, via `triggerUncaughtException`. The
box printed one `FAIL` line and exited, so lint/typecheck/build verdicts were real but the suite's
verdict covered only the tests before that one. A single failure is never evidence the rest passed —
re-run after fixing it.

Related: [[a-generator-script-run-in-the-primary-writes-the-shared-checkout]].
