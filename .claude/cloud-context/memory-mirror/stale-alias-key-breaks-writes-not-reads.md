---
name: stale-alias-key-breaks-writes-not-reads
description: "A stored normalized_alias that disagrees with normalizeAliasKey does NOT hide the alias from the importer — the read path recomputes; the damage is on the write path (duplicate upserts, failed deactivation) and then a conflict makes the key resolve to nothing"
metadata: 
  node_type: memory
  type: reference
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-10T08:08:08.512Z
---

Checked live 2026-08-10 while auditing the 2026-08-09/10 handover, which states the opposite as a
standing rule ("a stored key that does not match what the code computes is invisible").

**The read path recomputes and never reads the stored column.** `buildAliasIndex`
([crosswalks.ts:34](src/lib/sales/normalizer/crosswalks.ts:34)) and the per-distributor product
alias loop ([crosswalks.ts:157](src/lib/sales/normalizer/crosswalks.ts:157)) both call
`normalizeAliasKey(row.alias)`. crosswalks.ts:101 says so in as many words — "consistent regardless
of how the stored normalized_alias was produced". So a stale `normalized_alias` cannot stop an alias
from matching an incoming distributor value.

**The write path is where it actually bites** ([mapping.ts](src/lib/sales/normalizer/mapping.ts)):

- upserts conflict on `distributor_code,normalized_alias` (`:277`, `:383`) and on
  `normalized_alias,target_type,target_code` (`:300`) — a stale key misses the conflict target and
  **inserts a duplicate instead of updating**.
- deactivation/deletion filters `.eq("normalized_alias", key)` (`:405`, `:443`) — a stale key
  **fails to find the row**, so the old alias stays active.
- the partial unique index `source_of_sales_territory_aliases_one_active_target`
  `UNIQUE (normalized_alias, target_type) WHERE active` stops deduplicating.

Then two active rows collide on the *computed* key, `buildAliasIndex` treats it as a conflict,
**deletes the key and lets neither win** — so the alias does end up resolving to nothing, but by a
different route than the handover describes. Look for duplicates and failed supersedes, not for a
lookup that "never fires".

Live state 2026-08-10: **0 dead keys** across all four alias tables (product 448 active, territory
1,311, area 256, region 0) and **0 conflicting keys**. Recompute in Python by mirroring
`normalizeAliasKey` — fold Arabic-Indic digits, strip tatweel, `إأآا`→`ا`, `ى`→`ي`, non-letter/digit
→ space, collapse, lowercase.

Related: [[migration-timestamp-collides-across-parallel-branches]],
[[ignore-alias-deletes-and-the-manual-closing-decides]].
