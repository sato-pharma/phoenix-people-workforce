---
name: marketing-product-line-matching-broken
description: "RESOLVED - verified live in production 2026-07-27: marketing_products holds 23 rows with 0 NULL line_id, so the numeric path works and Anti-Inf reps can add products again. Kept for the lesson: matching a product to a line by TEXT breaks on 'Anti infective' vs 'Anti Inf'."
metadata: 
  node_type: memory
  type: project
  originSessionId: 77132691-db3d-4ec1-bf67-fd48dae8b4a4
  modified: 2026-10-01T00:00:00.000Z
---

In PRODUCTION (`ozucdzovmcqvepbozvqf`), the Marketing Requests draft workspace shows the wrong product set to line-scoped requesters, blocking submission.

Root cause in `marketingProductMatchesRequesterLine` (src/lib/marketing-requests/service.ts): it matches a product to the requester's line by (1) numeric `product.line_id === requester.lineId`, else (2) exact normalized text `product.line === requester.lineName`.

Production data state (verified 2026-06-06):
- All 21 `marketing_products` have `line_id = NULL` → numeric path is dead; everything relies on fragile text matching.
- Product line text values: `CNS` (15), `Pedia` (4), `Anti infective` (2).
- Org `lines` table: 1=`Anti Inf`, 2=`Pedia`, 3=`CNS`, 4=`Office`.
- Result: Pedia & CNS reps see products (names coincidentally match); **line 1 `Anti Inf` reps see 0 products** because `"Anti Inf" != "Anti infective"`; so they cannot add a product and cannot submit a request.
- Unrestricted roles bypass the filter (`canUseAnyMarketingProductLine`: system scope, Super Admin, SFE Manager) and see all 21.

Marketing module in prod is deployed + schema-applied but had ZERO operational rows (0 customers/pharmacies/requests/drafts) as of 2026-06-06 — module never used yet.

**RESOLVED — verified live in production 2026-07-27.** `marketing_products` now has 23 rows with
**0 NULL `line_id`** (CNS `line_id=3` ×15, Pedia `line_id=2` ×5, **Anti Infective `line_id=1` ×3**),
21 active. Backfilled by PR #168 (2026-06-14) plus the "Anti infective → Anti Inf" alias in PR #274.
The numeric path is live and Anti-Inf reps can add products again. Keep this memory for the lesson,
not the defect.

**Why it happened:** the reference importer populates product `line` text but not `line_id`, and product line names are maintained independently from the org `lines` table, so they drift.
**How to apply:** fix by backfilling `marketing_products.line_id` from the org lines (canonical, numeric match), and/or normalizing the line name mapping (`Anti infective`->`Anti Inf`). Don't rely on exact text equality. Related: [[supabase-dual-project-schema]], [[source-of-sales-rebuild-rules]].
