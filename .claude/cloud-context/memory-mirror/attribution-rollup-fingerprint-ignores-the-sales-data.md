---
name: attribution-rollup-fingerprint-ignores-the-sales-data
description: "au.f_monthly_achievement serves a precomputed rollup whose fingerprint covers the CONFIG surface only, so fixing sales rows changes nothing on Sales vs Target until f_refresh_monthly_attribution runs"
metadata:
  type: project
---

`au.f_monthly_achievement` does not always compute. It serves the precomputed
`au.monthly_attribution_rollup` whenever
`au.monthly_attribution_rollup_meta.config_fp = au.f_attribution_config_fingerprint()`,
and only falls back to a live computation when those disagree.

**The fingerprint covers the CONFIG surface — the line/area map, seats, occupancy — NOT the
sales data.** So correcting import or rollup rows leaves the fingerprint matching, the
precomputed rollup is served unchanged, and every achievement surface keeps reporting the old
number with no error and no staleness marker.

Measured 2026-09-01: after stamping July's 16 Anti Infective direct rows with their real areas,
Source of Sales agreed immediately while Sales vs Target still showed 149,288.50 EGP
unattributed. Nothing was wrong with the stamp. The refresh had simply never been asked for.

**How to apply:** after ANY correction to sales rows — an area stamp, a re-import, a line
remap, a closing repair — run `au.f_refresh_monthly_attribution('<period>')` before reading
Sales vs Target, the employee portal, employee-360, the business review, SFE team performance
or the admin dashboard, all six of which come from `phx_sales_vs_target_range`. Before running
it, diff stored against live attribution and confirm every differing row belongs to the line
you touched — that is what turns the refresh from a hope into a check.

**Why:** this is the exact opposite of the well-known hire trap
[[an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing]], where a CONFIG change
DOES move the fingerprint and silently staled the periods. Both directions bite; they just bite
different edits. Related: [[closing-reads-distributor-product-rollup-not-fact-rollup]].

🔴 **2026-09-11 — THE STEP BEFORE THIS ONE ALSO GETS MISSED: a ruling on the CUSTOMER MAP does not
touch the sales rows at all.** `source_of_sales_customer_map` is read at IMPORT time. Changing a
customer's brick or area re-points every FUTURE invoice and leaves every past one exactly where it
was, so the map says one area, `source_of_sales_import_rows` and `source_of_sales_fact_rollup` still
say the old one, and Sales vs Target keeps quoting the old area with no error and no staleness
marker. Five customers were left that way overnight — 14 rows, 7,242 EGP — and a peer session found
it after the fact, not the tooling.

**After a map ruling, restamp the OPEN months and only the open months:**

1. `source_of_sales_import_rows` — brick_id, area_code, region_code, block_code, area_name
2. `source_of_sales_fact_rollup` — brick_id, area_code, region_code
3. `source_of_sales_customer_presence_rollup` — region_code
4. then `au.f_refresh_monthly_attribution(period)` per affected period, diffing first as above

🔒 **A PUBLISHED MONTH KEEPS THE OLD AREA, AND THAT IS CORRECT, NOT A DEFECT TO SWEEP.** After the
2026-09-11 restamp, three Manfalout rows in **2026-08** still credit Assuit 2 while the map says
Assuit 1, worth 881 EGP. August is published and locked, and
[[never-fix-a-published-and-announced-month]] governs: the map and the rows are SUPPOSED to disagree
there. Any "0 map-vs-rows mismatches" claim is therefore wrong the moment a map ruling touches a
customer with locked-month sales — expect one mismatch per such row and check the PERIOD before
calling it a bug.

⚠ **Do not use `count(distinct area_code) group by customer_code` to find split pharmacies.** Every
distributor issues codes from its OWN catalogue, so a shared number is usually two DIFFERENT shops —
the same trap as [[ep-phs-reuses-one-client-code-for-different-pharmacies]]. Measured the same night:
199 by code alone, **94** once an identical folded customer_name is also required. Group on code AND
name, and validate the pairing per distributor pair before trusting it.
