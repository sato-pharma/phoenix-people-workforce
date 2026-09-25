---
name: attribution-is-period-aware-asof-not-todays-geography
description: "Sales attribution resolves region via au.f_line_area_map_asof(period_end), so an effective-dated geography change leaves earlier months untouched - the shorthand about todays geography is only true because rows are rarely closed. Also: a customer-map move never reaches a CLOSED month because import rows carry their own stamped area, so an attribution refresh that changes nothing is the correct answer; and a rollup diff written as a full join USING cannot match NULL to NULL and invents a huge fake discrepancy."
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-11T08:43:18.583Z
  originSessionId: a26f0586-5250-4a5e-a294-5e28e75a6f7d
---

**`au.f_monthly_attribution` and `au.f_monthly_achievement` both resolve an area's region through
`au.f_line_area_map_asof(v_period_end)` — the map AS IT STOOD at the end of the month being
computed, not as it stands today.** So a geography change dated forward does NOT disturb a closed
or in-flight month. Verified in production 2026-08-28 by reading `pg_get_functiondef`, not by
inference.

**This contradicts the shorthand in `AGENTS.md` §4** ("All SoS sales, historical and future,
attribute to today's geography — never as-was") and a code comment in
`src/lib/recruitment/candidate-region.ts` ("the closing resolves each area's region using TODAY's
map"). **Both are describing an OBSERVED behaviour, not the mechanism.** They are true in practice
only because almost no row in `au.line_area_map` has ever been closed — 3 of 150 before this date —
so `_asof` returns the single open row for every period and looks like "today's geography". Close a
row and the as-of machinery starts doing what it actually says. Do not quote either line as a
reason a dated change is unsafe; read the function.

The selection is `distinct on (line_code, area_code)` ordered by
`(effective_from <= p_asof and (effective_to is null or effective_to > p_asof)) desc, effective_from asc`
— note the **exclusive** upper bound and, more importantly, that there is **no WHERE clause**: when
no row is date-valid it silently falls back to the EARLIEST `effective_from` rather than returning
nothing. A period before the map's own history therefore resolves to the oldest row, not to null.

**How to apply — the date is the whole safety property.** To move geography from month M+1 while
leaving M intact, close the old row at `effective_to = <first day of M+1>` and open the new one at
`effective_from = <first day of M+1>`. Dating it *today* mid-month instead flips the CURRENT month
too, silently and with no error. Prove it before and after by calling
`au.f_line_area_map_asof('<M end>')` and `('<M+1 end>')` and reading the region back — a simulation
of the same ordering over hypothetical rows works read-only, before you write anything.

**Two things the as-of path does NOT protect**, both real:
- **"Current org" readers are not period-aware.** `brick-coverage.ts`, `coverage-filters-data.ts`,
  `region-resolver.ts` and the `line_area_map_current` unique index all key on `effective_to is
  null`, so the NEW row becomes visible to them the moment it is inserted, however far forward it is
  dated. A forward-dated move still changes what CRM boards and area grants show today.
- **`closing-organogram-regions.ts` reads `au_v_line_area_map` with no effective filter at all**, so
  it sees closed and open rows together once history exists.

**A CUSTOMER-MAP MOVE DOES NOT REACH A CLOSED MONTH, AND A REFRESH THAT CHANGES NOTHING IS THE
CORRECT ANSWER, NOT A FAILED ONE.** Each `source_of_sales_import_rows` row carries the `area_code`
and `brick_id` it was STAMPED with at import, and the attribution reads that, not the live
crosswalk. Measured 2026-09-11: after moving 74 pharmacies between areas, all four of June–September
matched a live recompute at **0 cells** in both directions, and only 59 of August's 13,010 rows on
those customers disagreed with the map at all. So repair the map, then expect the closed months to
sit still — which is also why a mapping fix is safe to apply while July and August are locked.

🔴 **THE DIFF THAT LIES: `full join … using (line_code, area_code, product_code)` DOES NOT MATCH NULL
TO NULL.** The rollup is full of null `area_code` (Head Office) and null `line_code`, so every such
cell comes back UNMATCHED FROM BOTH SIDES and is counted twice — once as "appeared", once as
"vanished". That reported **4,245,473 EGP moving in June, 45% of the month**, against a true answer
of zero; it looks exactly like a real discrepancy and would have been escalated. Diff with
`coalesce(col,'~')` in the key, or with `except` in both directions, and never quote a rollup delta
taken from a raw `using` join. Same family as the positive-control rule in `AGENTS.md` §2.1.

**Re-stamping a stale `config_fp` is safe but prove it.** `au.f_refresh_monthly_attribution(period)`
deletes and re-inserts the period's rollup, so on a LOCKED, published month take a pre-image of
`au.monthly_attribution_rollup` first, run it, then diff post against pre both ways. July 2026 read
stale on 2026-09-11 and came back 926 rows / 10,675,198.42 EGP / 123,732 units, identical to the
cent. Pre-image `july_attribution_backup_20260911` also holds the OLD meta row, so the staleness
marker itself can be put back.

`carries_target` is a GENERATED column (`area_state in ('occupied','vacant_will_hire')`) — never
insert it, and changing `area_state` silently changes whether an area carries a target. The
`trg_lam_region` trigger additionally requires `operational_region_code` to equal the
`dm_seat_id` seat's own `region_code`. See [[au-org-tree-is-sales-only]].
