---
name: sos-always-todays-geography-rule
description: "Owner rule: ALL SoS sales — historical and future — are attributed to TODAY'S geography. Never as-was. Implies every brick merge must repoint historical rows too."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-29T08:44:56.570Z
---

Owner, 2026-07-29, asked directly whether Jan–May historical uploads should use the geography as
it was at the time or as it is now:

> **"no all historical or upcoming todays geography"**

## The rule

**One geography, always the current one, for every period.** Sales are never attributed to the
territory structure that existed when they happened. Months stay comparable; a brick that merged in
July applies to January's numbers too.

**Why:** the whole point of the master is comparability across periods and clean rep/DM attribution
([[sos-owner-standing-rules-from-session-369dd08d]]). As-was attribution would freeze old months
against retired bricks and make trend analysis meaningless.

**Consequence he accepts:** a historical month's figures will NOT match whatever was reported at the
time, because the geography beneath them changed. That is expected, not a bug — do not "fix" it.

## What this obliges us to do

Imports already satisfy this for free: `loadCrosswalks` reads the CURRENT
`source_of_sales_customer_map` / bricks with no period filter, so any upload — January or next
December — resolves against today's master.

**The non-obvious part: every future brick merge/retire must ALSO repoint already-imported rows.**
Repointing `customer_map` alone is not enough — `source_of_sales_import_rows.brick_id` and
`source_of_sales_fact_rollup.brick_id` are frozen at import time. Skip that and old months silently
point at dead bricks, which is exactly the "as-was" outcome the owner rejected.

**Standard merge procedure (all in one transaction, then refresh rollups per batch):**
1. add the retired brick's name to `source_of_sales_territory_aliases` → survivor
2. repoint `source_of_sales_territory_aliases.target_code`
3. repoint `source_of_sales_customer_map.brick_id`
4. **repoint `source_of_sales_import_rows.brick_id`** ← the one that gets forgotten
5. delete the retired brick
6. `phx_refresh_sos_fact_rollup(batch)` + `phx_refresh_sos_customer_directory_rollup(batch)` — **one
   batch at a time**, never looped (a prior session took prod down for 2 min looping 89)

**Drift check — should always be 0:**
```sql
select count(*) from source_of_sales_fact_rollup f
 where f.brick_id <> '' and not exists
   (select 1 from source_of_sales_bricks b where b.brick_id = f.brick_id);
```

Verified clean 2026-07-29: fact_rollup 0, import_rows 0, customer_map 0, active aliases 0, against
696 current bricks. Only 2026-06 is loaded; Jan–May uploads pending.
