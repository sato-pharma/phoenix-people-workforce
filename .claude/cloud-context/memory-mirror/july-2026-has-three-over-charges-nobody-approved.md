---
name: july-2026-has-three-over-charges-nobody-approved
description: "July 2026's three apparent over-charges are the owner's OWN inline-typed figures, proven from the audit log — Essam's 1,451.63 is in the 11-row p2_vacation save of 8 Aug 02:03 whose 7,362.08 total matches the sheet exactly; its nine Finger Print under-charges are all already adjudicated in docs/."
metadata:
  node_type: memory
  type: project
  originSessionId: 5566e73c-38c0-4e93-b3c8-7857c2ef20ff
  modified: 2026-10-09T13:15:10.333Z
---

`payroll:reconcile-deductions 2026-07` (run `2f1660e5`, published **10 Aug 2026, 10:11 Cairo**)
reports 13 differences and 12,215.02 EGP "under-charged". 🔴 **NOTHING IN IT IS AN UNAPPROVED
CHARGE, AND NONE OF IT IS NEW.** Both halves are settled; do not re-raise either as a discovery.

**The three apparent OVER-charges are the owner's own typed figures.** Proven from
`automated_payroll_audit`, not inferred: `p2_vacation` was `step_saved` by **B-10** at **8 Aug 02:03
Cairo** with `edited: 11, inputMode: "inline"` and confirmed a minute later at **7,362.08 across 11
employees** — and the published sheet carries exactly **11 employees and 7,362.08**, Essam among
them. `p2_crm` was saved the same way at 02:09 (`edited: 18`, 16,055.31); the sheet holds 19 CRM
figures totalling 16,264.99, the one extra employee and 209.68 coming from the leaver settlement
engine rather than that step.

| Person | On the sheet | Module approved | What it is |
| --- | --- | --- | --- |
| Essam Mohamed Youssef Elsayed (B-164) | 1,451.63 | nothing | His approvals worth 967.75 were retired **4 Aug 11:41**, one minute AFTER `p2_vacation` was confirmed at 11:40; the figure was then typed inline on 8 Aug. |
| Mina Masoud Lamy Atta (B-124) | 1,548.00 | 1,032.26 CRM | ≈ approved CRM 1,032.26 + the never-approved 516.13 `no_records_activity`, typed and rounded down. |
| Mahmoud Ibrahim Ahmed Mohamed (A-1) | 1,250.00 loan | no loan candidate exists | The module is not the source for loans; a round typed instalment. |

So the module reads 0.00 because he entered these **on the step instead of approving candidates** —
the same shape as Aisha's typed 1,250.00 in September. The reconciliation cannot tell a typed figure
from a leak, and on a published month it should not try.

**The nine Finger Print rows reconcile to the piastre with
`docs/approved-deductions-that-never-reached-the-sheet.md`:** fully missed 8,925.81 (Ali Elsayed
6,183.86, **B-10's own row** 1,693.56, Mahmoud Ibrahim 620.97, Samaa Khalil 427.42) · partially short
4,280.03 (Amr Naguib, Hossam Reda, Nahed Hattab, Youmna Kotb) · 🔴 **correctly absent 2,225.81 —
Sameh Ahmed Ezzat is a HELD row with no July payslip at all, so "charged less" on him is a FALSE
shortfall.**

**How to apply:** treat July as closed. Never offer a correction for Essam, Mina or Mahmoud — they
are his decisions, and reporting them back as unapproved money repeats the error this note exists to
undo. **July has no cell provenance** (`automated_payroll_draft_cell_history` starts 7 Oct 2026), so
`automated_payroll_audit`'s `step_saved` / `inputMode: "inline"` rows are how a typed figure is
proven for any pre-October month — check there before calling any gap a defect. See
[[the-retired-reconcile-deductions-folder-is-load-bearing]] for the command's environment trap.
