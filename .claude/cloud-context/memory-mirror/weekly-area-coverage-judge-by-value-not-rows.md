---
name: weekly-area-coverage-judge-by-value-not-rows
description: "Weekly Sales area coverage looks fine by row count and terrible by value - always measure it in EGP and scoped to the tracked lines; the 98%-of-rows figure in the code comment is stale"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-26T20:50:51.478Z
---

**Weekly Sales area coverage must be judged by VALUE, never by row count — the two disagree by
almost 40 percentage points.** Scoped to the three tracked lines (see
[[head-office-products-are-not-tracked-weekly-golden-rule]] — never quote an unscoped weekly number),
measured live in production 2026-08-26 across 35,288 rows worth EGP 84,103,964:

- rows with no `area_code`: **10,428 / 35,288 = 29.6%**
- value with no `area_code`: **EGP 57,539,668 / 84,103,964 = 68.4%**

The depots nobody mapped are the big ones. **POS**, the largest tracked-line distributor
(EGP 47,795,859), is **69.6% unmapped by value** — 46 of 102 branches. **PS** is **75.8%** (70 of 179).
**Direct is 100%.** Unscoped — i.e. including Head Office — the same figures read 30.3% of rows and
81.7% of value; both are misleading and neither should be reported.

**The header comment in `src/lib/sales/weekly/manager-attribution.ts` says "34,138 of 34,838 rows
(98.0%) have no area_code, measured 2026-08-11". That row figure is STALE** — branches were mapped
since. Do not quote it. Re-measure before asserting anything about coverage, and quote the EGP.

**Why:** a row-count reading says "70% covered, nearly there" and invites someone to build an
area-level weekly report. The value reading says that report would be drawn from a third of the money
and silently omit the rest. Two sessions could read the same table and reach opposite conclusions.

**How to apply:** any weekly coverage claim gets a `sum(sales_value)` next to the `count(*)`, and an
`official_line <> 'Head Office'` filter. Same rule for the region side and for
[[sos-monthly-closing-is-the-only-sales-truth]] comparisons — see also
[[weekly-sales-cannot-follow-the-organogram-it-is-depot-data]].

## Update 2026-08-27 — the stale header figure is removed by PR #2436

PR [#2436](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2436) rewrites that header
comment and the "34,138 of 34,838 rows (98.0%)" line is gone from it. **Until that PR merges the
stale figure is still on `main`** — check which you are reading before quoting anything from it.
The rule above is unchanged: re-measure, and quote the EGP.

See [[weekly-anti-infective-ue-is-95pct-of-all-unmapped-value]] for what the 68.4% no-area figure
does and does not cost — most of it is harmless.
