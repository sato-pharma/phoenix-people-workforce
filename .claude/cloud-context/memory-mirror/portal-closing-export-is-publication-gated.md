---
name: portal-closing-export-is-publication-gated
description: "A manager's closing export loses its Matrix and Target sheets when that (line, period) is unpublished — silently, with no error"
metadata: 
  node_type: memory
  type: project
  originSessionId: 29be4ad6-ad17-4122-b3c4-9beec0e01c2d
  modified: 2026-08-09T23:02:11.356Z
---

**"His export has no targets" almost always means that (line, period) is not published.** Check
`monthly_closing_publications` FIRST — it is keyed by `normalized_line` + `period`.

`/api/sales/monthly-closing/export` has two branches:

- **Super Admin / system / SFE Manager / CEO** → full 10-sheet admin workbook. **Not** publication-gated.
- **Every other sales role** (DM/RM/NSM/PM/GPM) → skeleton from `loadPortalMonthlyClosing`, which
  **is** publication-gated. Unpublished ⇒ `matrix: null` ⇒ the route falls back to
  `buildClosingDetailsWorkbook` = invoice rows only, **no Closing Matrix and no Target vs
  Achievement sheet**. HTTP 200, a real .xlsx, no warning anywhere.
- Marketing Manager has her own third branch (`loadMonthlyClosingWithStoreSplit`) that skips the
  publication gate entirely — so she can get targets for a month a PM on the same line cannot.

Publishing is Super-Admin-only (`publish/route.ts`) and **emails every active District Manager on
the line** plus a fixed Cc/Bcc roster — never publish to "fix" an export without asking the owner.

**Why:** the empty-looking export reads as a data or permission bug and sends you into the scope
engine, which is fine. As of 2026-08-10 only `('Anti Infective','2026-07')` was ever published.

**How to apply:** before debugging a manager's missing targets, run
`select line, period from monthly_closing_publications`. Also check
`app_auth_users.product_scope_override` — it is a hard row filter, so a stale code list (or one
naming inactive products) yields a silently EMPTY workbook. See
[[ahmed-sharaf-is-the-cross-line-product-manager]].
