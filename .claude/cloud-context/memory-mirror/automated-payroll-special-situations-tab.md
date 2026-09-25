---
name: automated-payroll-special-situations-tab
description: "Special Situations Part 1 tab (owner spec 2026-07-25): shows ALL employees regardless of payment mode, one shared First/Second Part routing dropdown for both a manual deduction and addition. Shipped in PR #1335, migration applied to STAGING only (not production yet)."
metadata:
  node_type: memory
  type: project
  originSessionId: a18d5dc4-6334-443d-9a12-4265945f4a9c
  modified: 2026-07-25T12:47:05.387Z
---

Owner spec, confirmed via AskUserQuestion: show every employee (both one-part and
two-part payment mode — "part one and part 2" in the owner's wording referred to
payment mode, not the wizard's Part 1/Part 2 phases), with a deduction days/value
and addition days/value pair, and ONE shared "Apply To" (First/Second Part)
dropdown that routes BOTH the deduction and the addition together — not two
independent dropdowns ("whatever i choose is actually synced the same for
addition field").

**"Only allow First Part before Part 1 confirmed" needed NO bespoke gating code.**
Considered and rejected a phase-agnostic architecture; instead `p1_special_situations`
is a genuine member of `PART1_STEP_KEYS`, so it inherits the SAME `stepLocked`
mechanism (`automated-payroll-wizard.tsx`: `run.phase !== stepPhase(stepKey)`)
every other Part 1 tab already has — the whole step disables once Part 1 is
confirmed, so there's never a live moment where "First Part" could be wrongly
picked after freeze. Simpler than it sounds; resist re-litigating this.

**freezeFirstPart's first-ever addition term.** `split.ts`'s `FreezeFirstPartInput`
gained `otherPart1Additions` — every prior input only ever reduced First Part.
`assemble.ts` folds the Special Situations deduction/addition into the freeze
calc ONLY when `specialSituationPart === "first"`; otherwise they flow purely
through `PartsAdditions.otherAdditions` / `PartsDeductions.otherDeductions` in
`assembleParts`, landing entirely in Second Part via the same self-canceling
math the 4 existing manual tabs already rely on (see
[[automated-payroll-part1-other-deductions-4tabs]]).

**Bonus bug found+fixed in the same PR:** the xlsx Download/Upload round-trip
(`exports/step-template.ts`, `imports/step-parser.ts`) only ever read/wrote
`row.values` (numbers) — so the 4 already-shipped per-field Reason columns
(p1odCrmReason etc., live in production since PR #1333) silently exported as `0`
and could never be correctly re-imported. Fixed export, import, AND the
diff-preview to route `kind: "text"` through `row.reasons` and the new
`kind: "select"` through `row.selects`.

**Status 2026-07-25:** PR #1335 (same branch as the resignation-date/CRM-days/
Net-Salary work) — pushed, not yet merged. Migration
`20260725124026_automated_payroll_special_situations` (5 new draft_rows columns)
applied to **staging only** — production needs a separate explicit approval
before this can go live. Validated: typecheck/lint/429-test-suite/build all
green; new split.ts tests use the "prove it fails" pattern (verified they
actually fail when the addition term is removed, then reverted); live-verified
read-only against the real July 2026 production run via direct authenticated
fetch (117 rows matching Holds' population vs CRM tab's 24; Sameh Ezzat present
as `regular`; xlsx export succeeds for both this step and an existing
text-reason step). Full visual/screenshot browser verification was blocked by
the pre-existing headless-preview hydration limitation (see
[[local-browser-verify-gotchas]]) — not a code issue, confirmed via
`document.hidden === true` even while the tab reports active.
