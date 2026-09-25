---
name: sos-territory-aliases-is-the-brick-alias-table
description: "source_of_sales_territory_aliases IS the brick alias table (all target_type='brick'). Never build a second one — and repoint target_code when deleting bricks."
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-28T18:28:47.006Z
---

2026-07-28. Asked to make a new master the source of truth with "any other brick an alias",
I designed a brand-new `source_of_sales_brick_aliases` table. **Wrong — one already exists.**

`public.source_of_sales_territory_aliases` (prod, verified live):
- **1,213 rows, every single one `target_type = 'brick'`**, 798 active
- columns: `alias`, `normalized_alias`, `target_type`, `target_code`, `notes`, `active`, `source_file`…
- **268 rows already dangle** — `target_code` points at a brick_id that no longer exists
- this is what the owner means by "FULL TRAIN THE NORMALIZER" ([[sos-system-still-trained-on-old-bricks]])

**Two traps:**

1. **It hides from dependency scans.** The FK-less link column is `target_code`, NOT `brick_id`,
   so grepping `information_schema.columns` for `brick_id|brick_code|block_code` misses it
   entirely — the same silent-break class as [[sos-areas-must-never-be-deleted-au-linkage]].
   Deleting 184 bricks would have dangled **95 more** aliases (38 active) unnoticed.
2. **Building a second alias table splits the normalizer's brain.** Retired bricks must be
   written into `source_of_sales_territory_aliases`, and `target_code` repointed for survivors
   at the same time `source_of_sales_customer_map.brick_id` is repointed.

**How to apply:** any brick delete/merge must, in the same transaction, (a) repoint
`source_of_sales_customer_map.brick_id`, (b) repoint
`source_of_sales_territory_aliases.target_code`, (c) add the dead brick's name as a new alias
row pointing at the survivor. Check for dangling afterwards:
`select count(*) from source_of_sales_territory_aliases t where not exists
 (select 1 from source_of_sales_bricks b where b.brick_id = t.target_code);`
