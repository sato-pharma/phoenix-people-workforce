---
name: ahmed-sharaf-is-the-cross-line-product-manager
description: "B-155 Ahmed Sharaf covers Pedia AND Anti Infective, not just his employee-record line Pedia"
metadata: 
  node_type: memory
  type: project
  originSessionId: 29be4ad6-ad17-4122-b3c4-9beec0e01c2d
  modified: 2026-08-09T23:02:01.338Z
---

**Ahmed Sharaf Eldeen (HR_ID `B-155`, Product Manager) is a TWO-LINE PM: Pedia + Anti Infective.**
His `employees` row says Pedia only (`line_id` 2) — that single line is NOT his real scope.

- `app_auth_users.line_scope_override = {Pedia, Anti Infective}`, `sales_scope_override = LINE`.
- `product_scope_override` is deliberately **NULL** = both lines whole. Owner cleared it 2026-08-10:
  it had held `{TG001, OS001}` (Tigogrow + Osteosat), the only two **inactive** products across the
  two lines, both with zero July-2026 sales — which made every export he ran come back empty.
- He is also the one person named by HR_ID as a **Cc on EVERY line's** closing-publish email
  (`NAMED_CC_HR_IDS` in `src/lib/sales/closing-publish-recipients.ts`), explicitly "not the line's
  own PM on every line". That predates this and is the same owner intent.

**Why:** any change that infers a Product Manager's scope from `employees.line_name` /
`employees.line_id` silently halves his access, and reads as "working" because Pedia data appears.

**How to apply:** for sales scope always go through `resolveSalesAccessScope` (it folds in
`line_scope_override` and bridges the label to the canonical SoS official line — the DB value was
once stored as `"Anti infective"`). Never resolve a viewer's line from the employee directory for a
figures-bearing read. See [[portal-closing-export-is-publication-gated]] and
[[sos-always-todays-geography-rule]].
