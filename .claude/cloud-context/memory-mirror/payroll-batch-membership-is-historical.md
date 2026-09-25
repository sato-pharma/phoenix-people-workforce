---
name: payroll-batch-membership-is-historical
description: "A salary batch's membership is fixed when the batch is built — never re-derive it from today's employment status, or leavers vanish from months they were paid for (incl. the bank file)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4a13ab2c-b77b-4e77-a1ed-2dd1db5c413b
  modified: 2026-08-04T00:24:55.820Z
---

Found 2026-08-04 by the platform-wide data-integrity audit; fixed in PR #1682.

`src/lib/payroll/service.ts` tangled TWO concerns into one filter: `allowedHrIds` (a genuine
access rule — which employees this VIEWER may see) and `ineligibleHrIds`, a blocklist rebuilt on
every read from the CURRENT directory (`isPayrollIneligibleEmployee`: terminal
`employment_status` OR `payroll_eligible = false`). The blocklist was applied on top of scope for
EVERY viewer including COMPANY and system.

**Consequence: every historical batch silently shrank as people resigned.** Measured in production:

| Period | Rows | Hidden | Net hidden (EGP) |
| --- | --- | --- | --- |
| 2026-06 | 123 | 20 | 400,500.00 |
| 2026-05 | 130 | 28 | 548,500.00 |
| 2026-04 | 122 | 31 | 635,500.00 |
| 2026-03 | 117 | 30 | 501,000.00 |
| 2026-02 | 111 | 32 | 582,000.00 |
| 2026-01 |  88 | 24 | 419,500.00 |

**Total 165 rows / 3,087,000.00 EGP net.** It reached the BANK TRANSFER FILE, the batch export,
the statutory summary and the payslip routes — not just the dashboard. Ten of June's twenty had a
last working date AFTER June ended.

🔴 **The rule.** Who belongs in a NEW batch is a BUILD-TIME question (payroll template roster,
`automated-payroll/recommend.ts` — both period-aware, both untouched and still correct). It is
never a read-view filter on a batch that already exists. Access scope is the only limb allowed to
drop rows from an existing batch.

The same root cause made Payslips Center list a leaver's payslip whose document then rendered
blank (the list didn't filter, the document did) — one fix closed both directions.

`src/lib/payroll/eligibility.ts`'s docblock still tells the reader that dashboards and exports must
exclude terminal employees. That comment is the seed of this defect; the regression test
(`tests/payroll-batch-membership.test.ts`) carries `assert.doesNotMatch` contracts so the code
cannot come back even while the comment stays. Related: [[app-visibility-is-application-scoped-not-rls]].
