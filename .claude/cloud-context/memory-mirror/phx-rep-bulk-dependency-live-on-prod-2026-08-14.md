---
name: phx-rep-bulk-dependency-live-on-prod-2026-08-14
description: "phx_rep_bulk_dependency(from,to) + view phx_v_rep_bulk_dependency are LIVE on prod (08-14, #2131) — per-rep single-bulk-order dependency analytic; do not redo or undo"
metadata: 
  node_type: memory
  type: project
  originSessionId: 2ed8c704-753b-45f6-93b5-e34daa2b9f77
  modified: 2026-08-14T13:02:25.414Z
---

**Applied to production 2026-08-14 (PR #2131, merge commit `b2d62f2f`). Do not redo or undo.**

`public.phx_rep_bulk_dependency(p_from text default null, p_to text default null)` and its
parameterless companion view `public.phx_v_rep_bulk_dependency` flag every rep whose achievement is
≥100% but drops **below** 100% once their single largest **bulk** is removed — the larger of their
biggest single **direct order** or biggest single indirect **"whale" customer**. Output columns use
`bulk_*` naming (owner asked for "bulk", not "chunk") and resolve human-readable names (rep, area,
product/customer).

**How it's built (don't "fix" these):**
- A **read-only wrapper over `phx_sales_vs_target_range(from,to)`** — ALL attribution (Office
  value-share spread, area reassignment, the golden rule) stays inside that RPC and is NOT
  re-implemented. Product→line comes from the RPC's own output map (no hard-coded line labels).
- **Publication-gated** via `replace(monthly_closing_publications.normalized_line,' ','_') = line_code`
  — an unpublished (line, period) is intentionally absent, matching the live dashboard rule.
- **`SECURITY DEFINER`, execute to `service_role` only** (revoked from public/anon/authenticated) —
  mirrors the phx RPC. The repo's `check:migrations` SECDEF guard requires the literal
  `revoke execute on function … from public, anon, authenticated;` form — `revoke all … from public`
  does NOT satisfy its detector.

**KNOWN CAVEAT (documented in the function comment):** removing a whale removes only that customer's
own purchases; it does NOT re-simulate the Office value-share reallocation the customer pulls into
its area — so Office-heavy cases (the **EZ warehouse `1011654` on CNS**, Georgette/CA1) are
**UNDERSTATED**; true dependency is higher than shown. See [[owner-office-allocation-rule-value-share]]
and [[ez-warehouse-1011654-is-nasr-city-locked]] (EZ is now Heliopolis CA1).

**July 2026 finding (the only published month):** of 6 reps ≥100%, **5 flip** below 100% when their
one biggest bulk is removed — Georgette 154.5→72.5 (EZ whale), Hassan 136.6→25.3 (Lacto Advanced 1
direct), Hadeer 120.0→61.9 (LA001 direct), Ashraf 117.5→37.8 (الحجاز فارما whale), Yomna 106.1→94.5
(marginal, 11% chunk). Only **Warda 142.0→101.6 does NOT flip** — genuine broad sales. Verified live
on prod; EZ whale value 278,763.55 matches the independently-recorded July figure.

Ledger is **name-keyed** (`supabase_migrations.schema_migrations` recorded version `20260814125938`,
name `phx_rep_bulk_dependency`; the recorded version is an application-time stamp, NOT the file's
`20260814150000` prefix — this repo's applied versions never match the filename timestamp).
