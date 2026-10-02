---
name: sos-always-todays-geography-rule
description: "SoS attribution is PERIOD-AWARE: au.f_monthly_attribution/f_monthly_achievement resolve region via au.f_line_area_map_asof(period_end), and import rows keep the area/brick stamped at import — never re-geograph a past or published month. His 2026-07-29 'todays geography' words hold only while map rows stay open; a brick merge applies forward and never repoints a published month."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-10-02T16:40:12.138Z
---

Owner, 2026-07-29, asked directly whether Jan–May historical uploads should use the geography as
it was at the time or as it is now:

> **"no all historical or upcoming todays geography"**

## The rule (current)

**SoS attribution is PERIOD-AWARE.** `au.f_monthly_attribution` and `au.f_monthly_achievement`
resolve an area's region through `au.f_line_area_map_asof(period_end)` — the map as it stood at the
END of the month being computed, never at the run date. A geography change dated forward leaves
earlier months untouched; that date IS the mechanism behind the August / Delta (3), August / Upper
Egypt and August / Kafr El-Sheikh golden rules (the August closing never contains a 2026-09-01 move).
His 2026-07-29 words are true *in practice* only because almost no `au.line_area_map` row has ever
been closed, so the as-of lookup returns the one open row for every period. **Never quote them as a
reason a dated change is unsafe, and never resolve closing geography at the run date.** Full account:
[[attribution-is-period-aware-asof-not-todays-geography]]; rule in AGENTS.md §4 / `.claude/rules/sales-closing.md`.
**Superseded 2026-10-02:** previously "one geography, always the current one, for every period —
never as-was; a brick that merged in July applies to January's numbers too" — replaced by the
period-aware mechanism (verified via `pg_get_functiondef` 2026-08-28) and the dated August golden rules.

**Why he asked for comparability:** the whole point of the master is comparability across periods
and clean rep/DM attribution ([[sos-owner-standing-rules-from-session-369dd08d]]). That still holds
for a map row that is never closed — but where a move is dated, the date decides, and earlier months
keep their own geography.

**Published months do not move.** A PUBLISHED and announced month is never corrected, however
justified the fix (AGENTS.md §4); a late ruling is a rule for UPCOMING months.
**Superseded 2026-10-02:** previously "a historical month's figures will NOT match what was reported
at the time — expected, do not fix it" — the never-correct-a-published-month rule and the dated
geography rules.

## What this means in practice

Imports: `loadCrosswalks` reads the CURRENT `source_of_sales_customer_map` / bricks with no period
filter, so an upload resolves against the master **as it stands when it is imported** — and each
`source_of_sales_import_rows` row keeps the `area_code` and `brick_id` it was STAMPED with. A later
customer-map move therefore does NOT reach a closed month, and an attribution refresh that changes
nothing there is the correct answer (measured 2026-09-11).

**A brick merge/retire applies FORWARD.** Repointing `customer_map` reaches new imports; do NOT
repoint `source_of_sales_import_rows.brick_id` (or delete a brick those rows still reference) inside
a published or locked month — that restates a published closing. Ask the owner before touching any
historical rows.
**Superseded 2026-10-02:** previously "every brick merge must ALSO repoint already-imported rows —
`import_rows.brick_id` is the one that gets forgotten" — that applied today's geography to history,
which the period-aware rule and the never-correct-a-published-month rule forbid.

**Merge procedure for the master (one transaction, then refresh rollups per batch):**
1. add the retired brick's name to `source_of_sales_territory_aliases` → survivor
2. repoint `source_of_sales_territory_aliases.target_code`
3. repoint `source_of_sales_customer_map.brick_id`
4. `source_of_sales_import_rows.brick_id` — only for months NOT published or locked, and only with
   the owner's say-so (see above)
5. delete the retired brick — only once no row still references it (run the drift check below first)
6. `phx_refresh_sos_fact_rollup(batch)` + `phx_refresh_sos_customer_directory_rollup(batch)` — **one
   batch at a time**, never looped (a prior session took prod down for 2 min looping 89)

**Drift check — should always be 0:**
```sql
select count(*) from source_of_sales_fact_rollup f
 where f.brick_id <> '' and not exists
   (select 1 from source_of_sales_bricks b where b.brick_id = f.brick_id);
```

Verified clean 2026-07-29: fact_rollup 0, import_rows 0, customer_map 0, active aliases 0, against
696 current bricks. Only 2026-06 was loaded then; Jan–May uploads were pending.
