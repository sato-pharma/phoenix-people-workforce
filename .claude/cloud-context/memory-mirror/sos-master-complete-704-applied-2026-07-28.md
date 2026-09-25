---
name: sos-master-complete-704-applied-2026-07-28
description: "SoS master replaced in PROD 2026-07-28: 704 bricks / 154 blocks / 48 active areas, 100% Arabic, ZERO orphaned customer mappings. Backup sos_master_backup_20260728.restore_master()"
metadata: 
  node_type: memory
  type: project
  originSessionId: 47a721ae-e4ae-42e3-ae5a-303c30a10d5e
  modified: 2026-07-31T16:23:09.370Z
---

**LIVE IN PRODUCTION** (`ozucdzovmcqvepbozvqf`) 2026-07-28, owner said "go". Source of truth =
`C:\Users\satoh\Downloads\SoS MASTER - COMPLETE.xlsx` (stamped into `source_file`).

| | before | after |
| --- | --- | --- |
| areas | 49 (48 active) | 49 (**48 active**) — unchanged, OT3 still inactive |
| blocks | 220 | **154** (66 deleted) |
| bricks | 784 | **704** (87 retired, 7 added) |
| blocks with English names | **143** | **0** |
| customer_map rows | 49,712 | 49,712 (**none deleted**) |
| orphaned mappings | 0 | **0** ← 1,344 repointed |
| territory_aliases | 1,213 | 1,278 (+65 retired-brick names) |

**Why zero orphans:** the first crosswalk (against a 607-brick master) left 97 places with no
home and would have orphaned 1,037 mappings. Those 97 were generated back into the master as
`ADD THESE TO YOUR MASTER.xlsx` → owner-approved → master grew 607→704. Every one of the
remaining 87 retirements then had a canonical target. **Rule: never run the replace until
`retire_WITHOUT_target = 0`.**

**Backup / undo:** `select sos_master_backup_20260728.restore_master();` restores areas, blocks,
bricks, customer_map AND territory_aliases. Do NOT confuse it with the older
`sos_backup_20260728.restore_all()`, which restores only the 6 SALES tables and holds a stale
915-row bricks snapshot ([[sos-sales-purged-for-fresh-upload-2026-07-28]]).

Three traps hit and fixed during the run — all in [[sos-areas-must-never-be-deleted-au-linkage]]
and [[sos-territory-aliases-is-the-brick-alias-table]]:
1. Areas are `update … set active=false`, never deleted (au.* has no FK).
2. Retired bricks go into the EXISTING `source_of_sales_territory_aliases`, and its
   `target_code` must be repointed too.
3. `source_of_sales_territory_aliases` has a **unique INDEX** on
   `(normalized_alias, target_type, target_code)` that does **not** appear in `pg_constraint` —
   check `pg_indexes`. Needs `distinct on` + `on conflict do nothing`, plus a pre-delete of rows
   that would collide once repointed onto the survivor.

Also fixed a matcher bug worth remembering: an exact name match in the WRONG governorate beat a
correct match in the right area (`شارع صلاح الدين` Cairo → Alexandria). **Rank candidates by
geography FIRST (same area > same region > different), then by match strength.**

**Both follow-ups closed 2026-07-28:**

1. **Aliases are healthy, no cleanup needed.** 871 active aliases, **all 871 resolve to a live
   brick**. The 266 dangling ones are all `active = false`, and the normalizer only ever reads
   active rows (`selectAllActive` in `src/lib/sales/normalizer/crosswalks.ts:37`, `.eq("active",
   true)` in `normalizer/mapping.ts:299`). Supersedes the "aliases 72.6% stale" claim in
   [[sos-system-still-trained-on-old-bricks]] — that is now WRONG.
2. **The IMS editor already existed** — `/sales/database-mapping` → Areas tab → pencil icon,
   Super-Admin only. `ims_ratio` is declared editable (`definitions.ts:154`), `percent` is
   implemented end to end (input `step=0.0001 min=0 max=1`, `formatPercent` display, `0.00%`
   export, PATCH `app/api/sales/database-mapping/[master]/[key]/route.ts` gated on `sales`/`update`).
   Nothing needed building. The real gap was that **no write path enforced the Others rule** —
   `percentInvalidReason` only bounds 0..1, so a valid-looking `0.02` on an OT area broke the
   model, and `checkImsRatioIntegrity()` had **zero production callers**. Fixed by
   `othersRuleInvalidReason()` wired into all 4 write paths — **PR #1438**, typecheck/lint clean,
   463/463 tests pass.

Prod IMS verified intact after the master replace: non-OT areas `0.9503`, OT region `0.0497`,
total exactly `1.0000`, zero violations ([[sos-ims-ratio-storage]]).

## Carried over from the superseded 07-27 `FINAL NEW.xlsx` apply

That run (598 rows → 211 blocks / 1005 bricks, applied additively 2026-07-27) is **no longer the
live shape** — this 704-brick replace overwrote it, and its own memory was deleted 2026-07-31 to
stop the stale counts being quoted. Three things from it were never closed and do NOT appear
above:

- **1,252 `source_of_sales_customer_map` rows have an `area_code` that disagrees with their own
  `brick_id`'s area** (CA4→CA3 403, D22→D21 319, D17→D16 299, D15→D14 139). Pre-existing
  corruption, NOT caused by either apply. Those customers are attributed to the **wrong rep
  today**. Fixing it moves them between reps, so it is a commercial decision — owner's call, still
  unmade. See [[customer-area-code-is-inherited-and-unreliable]].
- **Two Database Mapping UI gaps the owner asked for.** `listMasterRows`
  (`src/lib/sales/master-data/list.ts`) does a bare `.select("*")` with no `active` filter, so the
  console mixes active and inactive bricks — he wants inactive in a separate tab. And
  `BRICKS.displayLookups` (`src/lib/sales/master-data/definitions.ts`) has no `block_name`, so
  Brick Master shows Block Code without the name — he wants it visible.
- **Why that file was safe where earlier drafts were not**, worth keeping as the acceptance test
  for any future master: its area codes came out *identical* to both `source_of_sales_areas` and
  `au.canonical_areas` (42/42, zero renames, zero recycled codes), so no rep attribution could
  silently shift. Earlier drafts recycled `D17`/`D21`/`D22`/`GZ7` onto different governorates —
  see [[au-schema-is-the-org-sos-linkage]].
