---
name: prove-it-fails-verify-which-assertion-fired
description: "A regression test only counts if you break the fix and confirm the NEW test's own headline assertion fires — 'the suite went red' has twice been red for the wrong reason"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-08T20:57:23.847Z
---

Before claiming a regression test pins anything, remove the fix and confirm the test fails. That
much is obvious. The part that has bitten twice is that **"it went red" is not the same as "my new
assertion caught it"** — and the difference decides whether the test was worth writing.

Two distinct failure modes, both hit in this repo:

**1. A pre-existing test caught it, so the new one adds nothing.** (PR #1533, CRM export scale.)
First break — dropping the *last* page — went red on the existing 4,500-row case (`4001 !== 4501`).
The new 40,000-row test proved exactly zero. Only a break that dropped rows **after page 10** was
invisible to the old test and visible to the new one. **Choose a break that ONLY the new test can
see**, and if you can't construct one, the test is redundant — say so instead of shipping it.

**2. An adjacent assertion in the same test fired first.** (PR #1535, vacation duration.) Reverting
the per-date collapse tripped `half_days` on the AM+PM case, which sits earlier in the file than the
headline `AM+AM = 0.5` assertion — so that headline claim was never reached and never proven. Fix:
read the assertion message in the failure, and if it isn't the one the test exists for, prove that
one separately (a scratch script printing the values under the broken code is enough).

**3. The break never actually landed, and the PASS looked like a verdict.** (2026-08-08,
doctor-coverage nav drift guard.) Twice in a row a patch reported nothing wrong and the test printed
PASS — which reads exactly like "the guard is broken" or, worse, gets accepted as "verified". First
time the shell/node nested quoting made `String.replace` a silent no-op; second time the needle
(`"Group Product Manager", "Marketing Manager"] },`) matched an EARLIER nav entry — `String.replace`
takes the first match, so it broke S1 Business Review instead of the line under test, and the test
correctly passed. **Make the patch script assert its own precondition and exit non-zero when the
needle is missing, and have it print the line number it changed.** Anchor on something unique (find
the line containing the href, then edit that line) rather than a role-list suffix that repeats.
A PASS is only evidence once you have proof the break was real.

**Never revert a break with `git checkout <file>` when that file also holds your real edits.** Same
session: reverting the temporary nav break with `git checkout src/config/system-navigation.ts`
silently discarded the actual role-list change, and `git status` then showed the file clean — which
reads as "nothing to do here" rather than "your work is gone". Copy to a backup first and restore
from the copy; `git checkout` cannot tell your edit from the break.

Also worth doing when a fix has several moving parts: **break each part in isolation**, not all at
once. #1535's page-boundary fix has five (`.gte` cursor, forced `id` projection, `withIdColumn`
itself, secondary `.order("id")`, the zero-added loop guard) — five separate breaks showed five
different assertions firing, which is what proves the test covers the whole fix rather than
tripping on the first thing it happens to notice.

**Why:** an unproven regression test is worse than none — it reads as coverage in review and in
future audits, so a real regression walks straight past it. Two of this repo's shipped bugs
(#1464's export corruption, #1520's dropped check-ins) had green suites at merge time.

**How to apply:**
- Apply the break with `perl -pi`/`python`, run, **restore from a backup copy**, and verify with
  `git diff --stat` that the source is byte-identical to HEAD before committing.
- Quote the actual assertion messages in the PR body as a table. It makes the claim auditable
  instead of asking the reviewer to trust "verified".
- Use a one-test scratch driver ([[test-seams-for-supabase-backed-code]]) so each break costs
  seconds, not a 41s full-suite run.

Related: [[crm-export-streaming-corruption-incident]] (correctness green ≠ safe to ship),
[[typecheck-incremental-false-green]], [[dont-foreground-watch-long-pipelines]].
