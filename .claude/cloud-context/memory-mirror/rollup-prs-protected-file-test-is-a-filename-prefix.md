---
name: rollup-prs-protected-file-test-is-a-filename-prefix
description: "`rollup-prs.mjs` decides \"protected file\" with `path.startsWith('src/lib/sales/office-allocation')`, so a NEW sibling file trips it — it labelled PR 5694 \"protected: the Office golden rule\" when the locked file was never touched; read the changed-file list before repeating that label to him."
metadata:
  node_type: memory
  type: project
---

`scripts/rollup-prs.mjs:81-85` classifies a protected file with five `startsWith` prefix tests, and
the Office one is `p.startsWith('src/lib/sales/office-allocation')`. The locked artifact is the
`GOLDEN RULE · LOCKED` region **inside `src/lib/sales/office-allocation.ts`** — but the prefix also
matches every future sibling, so `src/lib/sales/office-allocation-drift.ts` (a read-only detector that
cannot change the rule) trips it. On 2026-10-09 the script printed
`#5694 SEPARATE … protected: the Office golden rule (src/lib/sales/office-allocation-drift.ts)` while
`git diff --name-only origin/main...HEAD` showed `office-allocation.ts` untouched. The same shape
waits on `payroll/policy*`, `incentives/scheme-2026*` and `employee-portal/identity-card*`.

**Why it matters more than a cosmetic label.** A peer session read the line and was about to tell the
owner that 5694 needed its own approval *because it touches the Office golden rule* — a sentence
about the one lock a session cannot talk itself past, and false. The roll-up verdict itself was
unaffected (10 files is not "small", which is `<= 4`, so it could never have been grouped anyway), so
the defect is purely in what gets SAID to him.

**How to apply:** never repeat the script's `protected:` line without `git diff --name-only
origin/main...HEAD | grep -x <the locked path>` — the exact path, not a prefix. The fix is to test the
locked paths exactly (`.ts`-anchored, or the locked region's own file list) rather than by prefix; it
is one line plus an assertion and belongs in the next PR that already touches `scripts/`, never a PR
of its own — see [[hold-a-whole-feature-for-one-pr-even-when-he-asks-in-pieces]] and the §6 rule that
he never gets more than one merge at a time.
