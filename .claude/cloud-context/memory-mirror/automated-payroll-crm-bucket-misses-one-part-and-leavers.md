---
name: automated-payroll-crm-bucket-misses-one-part-and-leavers
description: "Confirmed CRM/unpaid-vacation deductions reach NO Automated Payroll step for one-part employees — owner ACCEPTED this on 2026-08-04 as documented-and-closed, 0.00 EGP exposure; reopen only if field-workforce staff move to one-part pay"
metadata: 
  node_type: memory
  type: project
  originSessionId: 72fa84e6-f458-4a38-8eb0-e1ecfadbe762
  modified: 2026-08-04T00:27:01.507Z
---

**DECIDED 2026-08-04 — accepted, do NOT "fix" this without the owner reopening it.**

PR #1657 wired Automated Payroll to the Deductions module (`deductions-source.ts`), but only for
**continuing two-part employees** on the CRM and unpaid-vacation buckets.

- `recommendCrm` (`p2_crm`) and `recommendVacation` (`p2_vacation`) both `continue` on
  `isSettledInPart1` — i.e. they skip leavers and `one_part` employees.
- `p1_crm`, `p1_resignation_crm` and `p1_unpaid_vacation` are **never passed**
  `loadConfirmedDeductions` (see `recommendStep`'s dispatch in `recommend.ts`).

**Measured exposure, production 2026-08-04 — this is why it was accepted:**

| population | employees | CRM/vacation candidates ever | approved | EGP |
| --- | --- | --- | --- | --- |
| `two_parts` | 142 | 57 | 37 | 28,862.86 |
| `one_part` | 20 | 1 | 0 | **0.00** |

All 12 `dsm_no_record` and all 4 `holiday_bridge` candidates are `two_parts` too.

**Why:** three reasons, in order of weight.

1. The overlap is structurally near-empty, not lucky — the CRM/vacation connectors target the field
   workforce, and one-part employees are essentially not field workforce.
2. **Half the "fix" would be a regression.** Leavers are NOT missing these figures; they get them
   from a deliberately different, owner-specified engine (2026-07-26): `Base ÷ the month's actual
   days` rather than /30, capped at days worked so no post-resignation day is deducted. Feeding the
   module's figure in would overwrite that with a cruder rule. Only the one-part *continuing* case
   is genuinely unfed — the case with 0.00 EGP behind it.
3. `isSettledInPart1` is used in BOTH directions to keep the Part 1 and Part 2 populations
   disjoint. Wiring the module into a Part 1 step without removing the matching Part 2 path
   double-charges the same days — silent, and against the employee.

**How to apply:** treat this as closed. The single trigger that reopens it is **field-workforce
staff (especially district managers) moving onto one-part payment** — that makes it live
immediately. Recorded in the `DeductionBuckets.crm` doc comment in
`src/lib/automated-payroll/deductions-source.ts`.

Found during the #1653 ⨯ #1654 ⨯ #1657 composition audit (PR #1680, merged `22f1ad72`), which
confirmed the never-auto-publish rule DOES survive into payroll — payroll gates on
`Approved for Payroll` alone, a strict subset of `isEligibleForPublish`, pinned by
`tests/payroll-deduction-gate-composes-with-publish-rule.test.ts`.

Related: [[payroll-deduction-rules-owner-spec]] · [[direct-order-sales-month-is-finance-owned]]
