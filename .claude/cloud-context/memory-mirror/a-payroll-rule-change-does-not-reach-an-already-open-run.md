---
name: a-payroll-rule-change-does-not-reach-an-already-open-run
description: "A saved Automated Payroll draft row is an OVERRIDE and beats the recomputed value, so shipping a payroll rule change does not move an already-open run - the numbers stay wrong with no error and no warning. Also records the 2026-08-29 joiner rule (prorate on NET)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 10c9e0cd-506e-4881-977d-63fca5e0190c
  modified: 2026-08-29T14:57:11.008Z
---

**Shipping the code is only half of a payroll rule change.** `automated_payroll_draft_rows`
stores `base_for_month`, `ecol_paid` and `fuel_paid` per employee, and `recommend.ts`
resolves each with `pick(draftValue, recommended) => draftValue == null ? recommended : draftValue`.
**A non-null stored value WINS.** Saving a step in the grid persists the then-current
recommendation into every visible row, so an open run silently freezes the rule that was
live at save time.

**Why this is dangerous rather than merely annoying:** the run then looks completely
normal. There is no error, no warning, and no visual difference between "this figure is
the current rule" and "this figure is a fossil of the rule you just replaced". The only
tell is that `updated_at` on many rows shares one millisecond — a bulk grid save, not
per-row edits.

**The fix is to CLEAR the overrides, not to overwrite them with new numbers.** Setting the
columns back to NULL restores "no override" and lets the engine drive — the same thing the
grid's own reset button does, and self-healing if a salary or the rule changes again.
Overwriting with hand-computed values just installs a new fossil.

**How to FIND a bad one: price every row with the engine and diff it against the stored value.**
A stored figure that equals the computed one is a harmless fossil; a gap is a real defect. On
2026-08-29 that diff caught `CN-0006` Adel Eid carrying a **whole month's base (16,500) although he
was hired on the 2nd** — 532.26 too much, wrong under the old rule as well as the new one, and
invisible because a plausible number in a base column looks like a salary, not like an override.
The owner confirmed 16,500 was his FULL-month base, which is what made the stored value diagnosable.

**Order matters: deploy first, then clear.** Clearing before the new code serves makes the
*old* code recompute, which produces a third set of wrong numbers on screen.

**CLEARING IS NOT PERMANENT — the freeze comes back the next time anyone saves a step, so
re-measure it immediately before you rely on it, never from an earlier note.** Measured
2026-08-29: overrides cleared at ~15:15 Cairo were back on 12 rows by **17:18:58.379**, all twelve
sharing that one millisecond (the bulk-save signature), 33 minutes before the leaver rule shipped
at 17:51. **A save freezes only the rows VISIBLE in the step being saved**, which is what saved that
release: the 17:18 save was on the New Hires step, so it froze all 12 joiner rows and left the 3
leaver rows NULL, and the new leaver rule reached every one of them with nothing to clear. Do not
generalise that into safety — it means the blast radius of a save is *the step you are looking at*,
so the danger is shipping a rule for the same step someone just saved. The check before trusting any
run is one query: count `base_for_month is not null` on that run's rows, split by whether the person
has a resignation row. `frozen_leaver_rows = 0` is what proves a leaver-rule change will land.

**Worked instance, 2026-08-29.** Owner replaced the joiner proration rule: a mid-month hire
is now paid `Net (Base + ECOL + Fuel) / calendar days x days worked`, hire day inclusive,
replacing TWO rules that had disagreed since 2026-08-09 — the automated engine prorated
base and paid ECOL+Fuel whole below the 15th / half above, the Ready sheet prorated base
and paid both whole. Merged as #2650. The August run already held 12 rows of frozen
old-rule figures; clearing `ecol_paid`/`fuel_paid` moved Yasmine El Safoury (HR-009) from
6,129.03 to the owner's own figure of **4,645.16**. Pre-image kept in the production schema
`joiner_proration_backup_20260829`. **Leavers were NOT changed** — see
[[resignation-full-pay-rule-is-resignation-only]].

**Two residues worth knowing.** (1) The two engines now differ by **0.01 on some rows**: the
automated engine sums three rounded components (so a row's parts always add up to its own
total) while the Ready sheet rounds `net - deduction` once. Deliberate, not a defect.
(2) A person whose `base_salary` is 0 but who has allowances is now materially affected,
because the allowance IS the salary and it now prorates — see
[[people-with-no-salary-figure-are-priced-at-nothing]].

**Published months are history.** July 2026 holds 11 rows with the same kind of override and
must never be "fixed" — it is published and paid.
