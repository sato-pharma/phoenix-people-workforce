---
name: b155-two-line-pm-scope
description: "B-155 (Ahmed Sharaf) is the Product Manager for 2 SPECIFIC cross-line products (not a two-line PM) — LIVE in production since 2026-07-03"
metadata: 
  node_type: memory
  type: project
  originSessionId: 79edc018-f0ed-43ae-a1f8-31ecd901936e
---

**LIVE IN PRODUCTION as of 2026-07-03.** B-155 = Ahmed Sharaf Eldeen, Product Manager. Final model (clarified over the course of the fix): he is NOT a generic "PM who covers two lines" — he is the PM for **exactly 2 named cross-line products**, Tigogrow (`TG001`, Pedia) and Osteosat (`OS001`, Anti infective). Line-level scope (Pedia + Anti infective) applies to HR/org modules; product-level modules (sales AND marketing) are hard-clamped to exactly those 2 products, not his whole line's catalog. His manager (A-8, GPM Rasha) and reporting chain **B-155 → A-8 → A-9** (A-9 = Marketing Manager Hossam, Head Office line) are unchanged — confirmed still `employees.line_id=2, manager_hr_id=A-8` throughout (scope-only fix, no `manager_hr_id` touched).

Mechanism = per-user override columns on `app_auth_users`: `line_scope_override text[]` (line names) + `product_scope_override text[]` (product codes) + `sales_scope_override`. Admin UI "Scope & Visibility Overrides" (`scope-visibility-manager.tsx`) product picker only lists EXISTING products, so pre-launch codes need SQL. Read helpers in `src/lib/auth/scope-visibility.ts`. A-10 is the (simpler, single-line) precedent — LINE + `['Anti infective']` + `[SA001,RO001]`.

**PR #763** (merged, commit 10867c1e): wired the override into surfaces that only used the single employee line before — plan double-visit rep pool, sales (`sales/access-scope.ts` `resolveSalesAccessScope` reads `line_scope_override`; confirmed `sos-dashboard.ts`/weekly-sales `access.ts`/Sales Intelligence all funnel through this one resolver, so the fix cascades to every sales dashboard), marketing (initially additive/union), organogram (multi-line path keeps the upward chain so A-9 renders). Also unified marketing product codes with sales — see [[sales-marketing-product-code-namespaces]] (migration `20260703310000_unify_marketing_product_codes_with_sales.sql`, applied to production 2026-07-03).

**PR #764** (merged, commit ae492474): the union semantics from #763 were too broad for marketing — B-155 could still see/submit his OTHER native Pedia products (Guamusin etc.), not just his 2 assigned SKUs. Added a **named, HR_ID-scoped exception** in `marketing-requests/service.ts` (`PRODUCT_SCOPE_EXCLUSIVE_HR_IDS = ["B-155"]`, inside `marketingProductAllowedForRequester`) that hard-clamps HIS marketing visibility/submission to exactly `product_scope_override`, matching sales. Deliberately scoped to this one HR_ID only — every other `product_scope_override` user (A-8, A-10) keeps the general union behavior. Pattern to reuse if another employee needs the same "exactly N named products, not a whole line" treatment: add their HR_ID to that same set.

**FULLY LIVE AND VERIFIED on production as of 2026-07-03, 22:47 EEST** (both PRs merged, deploy confirmed): `git merge-base --is-ancestor` confirmed both 10867c1e (#763) and ae492474 (#764) are ancestors of `origin/main`; the production deployment created immediately after the #764 merge (`dpl_EkzqMy4HJQaeCYvkkQih4mJvnPp2`) reached Ready and its **Aliases list explicitly includes `https://phoenix-workforce.vercel.app`** — i.e. the public domain is confirmed serving this exact build, not a stale one. DB re-queried fresh at verification time and matched expected state exactly (see below). Nothing left pending on this task except the real price/launch flip.

**B-155's production data state (re-verified after both merges):**
- `app_auth_users` (login_id=B-155): `line_scope_override=['Pedia','Anti infective']`, `product_scope_override=['TG001','OS001']`, `sales_scope_override='LINE'`. Confirmed exclusive — no other active user's override references TG001/OS001.
- Tigogrow (`TG001`, Pedia, line_id 2) + Osteosat (`OS001`, Anti infective, line_id 1) exist in BOTH `source_of_sales_products` and `marketing_products` with the same code in each. Both `factory_price=0` (placeholder) and `active=false` (pre-launch). **Follow-up needed at real launch:** set the real `factory_price` and `active=true` on both rows in both tables, or sales/marketing will show a $0 line item.
- `employees` (hr_id=B-155): `line_id=2`, `manager_hr_id=A-8` — untouched throughout, hierarchy B-155→A-8→A-9 intact.
