---
name: ahmed-sharaf-is-the-cross-line-product-manager
description: "B-155 Ahmed Sharaf is the PM for FOUR named products — Guamusin, Ivyronc, Tigogrow, Osteosat (owner, 2026-09-28) — and his product_scope_override must NEVER be cleared to NULL, which shows him ZERO marketing products"
metadata:
  node_type: memory
  type: project
  originSessionId: 29be4ad6-ad17-4122-b3c4-9beec0e01c2d
  modified: 2026-09-27T23:30:42.640Z
---

**Ahmed Sharaf Eldeen (HR_ID `B-155`, Product Manager, `manager_hr_id = A-8`) is the PM for FOUR
named products, not for a line.** Owner instruction 2026-09-28: *"Ahmed Sharaf now responsible to
Guamusin and Ivyronc along side with his current products."* Applied to production the same day.

| Code | Product | Line | State |
| --- | --- | --- | --- |
| `GU001` | Guamusin | Pedia | active, 60.75 — **added 2026-09-28** |
| `IV001` | Ivyronc | Pedia | active, 30.375 — **added 2026-09-28** |
| `TG001` | Tigogrow | Pedia | pre-launch (`active=false`, price 0) |
| `OS001` | Osteosat | Anti Infective | pre-launch (`active=false`, price 0) |

His `employees` row says Pedia only (`line_id = 2`); that single line is NOT his scope.
`line_scope_override = {Pedia, Anti Infective}` and `sales_scope_override = LINE` carry the HR/org
half; the four codes are the product half.

🔴 **NEVER clear his `product_scope_override` to NULL.** He is the one HR_ID inside
`PRODUCT_SCOPE_EXCLUSIVE_HR_IDS` (`src/lib/marketing-requests/service.ts`), which hard-clamps his
marketing product list to **exactly** that array instead of the usual line ∪ override union. On the
sales side NULL means *no restriction*, so a NULL reads as generous — but
`productCodeInScope(code, null)` returns **false**, so in marketing it means *nothing at all*. That
is what happened between 2026-08-10 and 2026-09-28: the owner cleared the then-`{TG001, OS001}`
array because both products were inactive with zero sales and every export came back empty, and from
that day his marketing-request product dropdown was **silently empty** — `canCreateDraft` still
true, zero products to pick. Adding the two live Pedia products fixes the original complaint
(his list now carries real selling products) without reopening the hole.

**The list lives in TWO stores and they must match** — `app_auth_users.product_scope_override` and
`weekly_sales_product_scope` (rows keyed by the LOWER-CASED hr_id, `b-155`). Owner ruling 2026-09-18;
both screens write through `src/lib/sales/product-scope-list.ts`. Change it on a screen, or write
both tables in one go — never one of them. See [[b155-two-line-pm-scope]].

**Not changed, deliberately:** `A-8` (Rasha, Group Product Manager, his manager) keeps
`{GU001, IV001, LA001, LA002}` and `A-9` (Hossam, Marketing Manager) keeps the whole catalogue — a
rung above him covering his products is the designed shape, not a duplicate. He also stays the one
person named by HR_ID as a Cc on EVERY line's closing-publish email (`NAMED_CC_HR_IDS` in
`src/lib/sales/closing-publish-recipients.ts`).

**How to apply:** for sales scope always go through `resolveSalesAccessScope` (it folds in
`line_scope_override` and bridges the label to the canonical SoS official line — the DB value was
once stored as `"Anti infective"`). Never resolve a viewer's line from the employee directory for a
figures-bearing read, and never infer a PM's products from his line.
See [[portal-closing-export-is-publication-gated]] and [[marketing-manager-outranks-product-manager]].
