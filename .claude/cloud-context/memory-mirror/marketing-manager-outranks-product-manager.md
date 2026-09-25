---
name: marketing-manager-outranks-product-manager
description: "Marketing Manager (A-9 Hossam) sits ABOVE Product Manager (A-10 Nahed) — owner confirmed 2026-08-19; do not invert the marketing ladder"
metadata: 
  node_type: memory
  type: project
  originSessionId: d6345180-9a11-4134-8d8d-63ae4aa22e6f
  modified: 2026-08-19T14:53:53.927Z
---

The marketing ladder is **Product Manager → Marketing Manager → CEO**, confirmed by the owner on
2026-08-19 against live production data:

- `A-9` Hossam Mohamed Reda AboElftouh — **Marketing Manager**, `manager_hr_id = AA` (CEO)
- `A-10` Nahed Tarek Hassan Omar Hattab — **Product Manager**, `manager_hr_id = A-9`
- `A-8` Rasha Sabry Sayed Khalifa — Group Product Manager, `manager_hr_id = A-9`
- `B-155` Ahmed Sharaf Eldeen — Product Manager, `manager_hr_id = A-8`

`marketing_review_routing` agrees: line 1 → `reviewer_role = 'Marketing Manager'`,
`cc_roles = ['Product Manager']`. The Marketing Manager **decides**; the Product Manager is only
**copied** to comment.

**Why:** on 2026-08-19 the owner described the Product Manager as "number one in marketing" and the
Marketing Manager as "number two", which reads as the reverse of the org data. Asked directly, he
confirmed **the data is right** — the real defect was only that the CC rung printed the reviewer's
job title next to the Product Manager's name, so two rungs both read "Marketing Manager". Do not
re-open this as an org-structure problem.

**How to apply:** if a session is ever asked to "swap" or "shift" the Product Manager and Marketing
Manager approvals, treat it as a **labelling** question first and check `assigned_role` on the CC
rung before touching `manager_hr_id`, `marketing_review_routing`, or the approval chain. Related:
[[marketing-manager-chain-target-is-sales-only]], [[organogram-chart-source-is-au-seat-model-not-directory]].
