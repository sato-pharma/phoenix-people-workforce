---
name: sos-duplicate-brick-names-are-decoys
description: "SoS brick-name twins are CLOSED (owner, 2026-09-11): all five duplicate names were disambiguated by RENAME with an area suffix, so every brick name is now unique (verify.sql check 84) — nothing merged, moved or deleted. 🔴 The old 'the empty twin is a decoy, delete it' reading is FALSE and went stale within hours (فوه B200-5 holds 70 customers / 446 sales) — never merge or delete a twin on a written count; ask production. Durable trap: when a brick id and an area label disagree, believe the AREA and find the same-named brick inside it — it runs BOTH ways. The July name-match remap (895 pharmacies) is a SETTLED owner decision, not a defect: never re-open, never 'fix' a kept row back toward its address."
metadata:
  node_type: memory
  type: project
  originSessionId: f3deb2a3-78c9-4188-9750-0ce65dec6904
  modified: 2026-09-25T23:48:58.516Z
---

## The whole decoy problem is CLOSED — every brick name is now unique

Owner, 2026-09-11: all five twin pairs were disambiguated by **RENAME with an area suffix**. Nothing
was merged, moved or deleted; every customer, sales row and alias stayed exactly where it was. **The
rule used: the twin that the plain-name TERRITORY ALIAS already points at keeps the bare name, the
other takes an area suffix** — the resolver's own answer, not a judgement. **Do NOT "restore" a bare
name.** Pinned by `verify.sql` check 84 (zero brick names used by more than one brick) and check 85
(`B200-5` keeps its suffix). Pre-image `is_twin_backup_20260911.bricks_pre` (10 rows).

| Kept the bare name | Renamed |
| --- | --- |
| `B200-14` الحامول (Kafr El-Sheikh 2) | `B170-1` → `الحامول - كفر الشيخ 1` |
| `B200-13` بيلا (Kafr El-Sheikh 2) | `B170-2` → `بيلا - كفر الشيخ 1` |
| `B199-9` فوه (Kafr El-Sheikh 1) | `B200-5` → `فوه - كفر الشيخ 2` |
| `B198-6` الخطاطبة (Imbaba) | `B157-3` → `الخطاطبة - البحيرة 1` |
| `B28-47` باب الشعريه (Down town) | `B17-28` → `باب الشعريه - القاهرة شرق 1` |

⚠ **A rename disambiguates the PICKER; it decides no mapping.** A pharmacy whose address says `فوه`
can still legitimately belong to either brick — the two are adjacent halves of one town across an area
boundary (which is why the distributor calls `B200-5` "FOHA - MOTOBAS"). Renaming touches nothing
else: aliases point at `target_code`, not names.

## 🔴 The "one twin is empty, so the empty one is a decoy" reading is FALSE — never delete on a count

The original table in this file said one twin of each pair carried all the sales and the other exactly
zero. **It was true when written and went stale within hours** — `فوه` `B200-5` measured **70 customers
/ 446 sales** the same evening, and `B157-3` الخطاطبة gained a real pharmacy. **A session that reads
"the decoy carries zero" and deletes or merges a twin destroys live customers and sales rows.** Ask
production for the counts; never trust a table in a memory or a doc. Never delete a husk either — a
renamed-empty brick keeps its suffixed name as a marker ([[sos-areas-must-never-be-deleted-au-linkage]]).

## The durable trap — id vs area label

When a brick **id** and an **area label** disagree (a mapping sheet's Brick-ID column vs its Area-Name
column), **believe the AREA and look for the same-named brick inside it.** This cost real time on
2026-08-09 when a customer was moved onto the wrong same-named brick from a sheet's id column. It runs
**BOTH ways** — `فوه` real is Kafr El-Sheikh **1**, the others' real twin is Kafr El-Sheikh **2** — so
"the Kafr El-Sheikh 1 one is always wrong" is NOT a rule. Check a brick id against the area on the same
row before accepting it.

**Relocating a brick touches FOUR layers** ([[moving-a-sos-brick-between-areas-needs-four-restamps]]):
`source_of_sales_bricks` alone repoints nothing; `customer_map` / `import_rows` / `fact_rollup` /
`customer_directory_rollup` each keep their own stale `area_code`.

**Do NOT "fix" `customer_map.area_code` in bulk.** ~901 of the ~910 rows whose area disagrees with
their brick are the deliberate Fayoum (GZ6) / Beni Suef (UE9) split
([[fayoum-beni-suef-golden-rule-per-line]]); `phx_closing_customers` reads that column directly, so a
blanket rewrite moves 901 customers out of Fayoum in one statement.

## The alias table is a SECOND surface

`source_of_sales_territory_aliases` resolves a NAME for every future import, so **a zero-customer brick
is still reachable** — two retired-brick aliases mapped nothing at all until repointed 2026-09-11
(pre-image `kes_alias_backup_20260911`). **After any brick retirement, sweep the aliases too:** an
active alias whose `target_code` is not an active brick is the whole test. Two indexes govern the table
(both plain indexes, not constraints): unique `(normalized_alias, target_type, target_code)`, and unique
`(normalized_alias, target_type) WHERE active` — **one active alias per name.** So repoint IN PLACE; and
where a retired row already points at the destination, retire the live one FIRST and wake the old one,
or the partial index rejects the write.

## The July name-match remap is a SETTLED owner decision, not a defect

The 674→668 brick plan left 14 live bricks uncovered ([[reallocation-668-bricks-full-plan-live]]).
Twelve were reallocated purely because the old brick's NAME matched one in the new master, moving
**895 pharmacies to a new AREA with no address evidence recorded for any of them.** Put to the owner as
a dropdown sheet 2026-09-11 and answered: ten *keep it in the new area*, one — `B28-47` باب الشعرية,
Down town → Cairo East 1 — *put it back*. Pre-images `bab_elsheria_backup_20260911`,
`keep_bricks_backup_20260911`.

🔴 **A fresh audit re-derives all 895 as "customers in the wrong area" every single time.** They are
now **owner decisions, not defects** — never re-raise them, never "fix" a kept row back toward its
address. Same trap as the finished SoS audit in `AGENTS.md` §4. Two mechanical notes: a drifted row is
sent to the brick its SIBLINGS use, never to the brick the July file named (four of those target ids no
longer exist — the master was replaced again 2026-07-27 after the file was written); and 🔴 **never
quote a per-brick row count in a document** — the crosswalk is written continuously by several hands, so
a count is stale within the hour (`docs/source-of-sales-decisions.md` §5 was off by two within 30
minutes). Put the RULING in the doc and ask production for the numbers.

**The set of fourteen uncovered bricks exists in EXACTLY ONE place — the memory file
[[reallocation-14-uncovered-bricks]]**, which lists all fourteen ids. Production and the repo CANNOT
reproduce it: a customerless brick appears in no customer map, pre-image or rollup, and `B25-43` is gone
from `source_of_sales_bricks` itself. Asked three times by two sessions — hand over the file path when
a peer asks. The fourteenth, `B25-43` مديرية التحرير, was never a name match (a legacy catch-all split
by address across Badr, Sadat City, Kom Hamada, Buraijat), so it is not one of the 895 and not a missing
ruling — the heading counts 14 BRICKS, the table counts 13 RULINGS.

## 🔒 OWNER RULING 2026-09-11: باب الشعريه belongs to Down town (`CA5`), not Cairo East 1

The one pair where the alias and the sales rows disagreed — and the ALIAS was right. All 18 customers
were moved off `B17-28` (Cairo East 1) onto `B28-47` (Down town), which already held the five aliases.
Because this SUPERSEDES an earlier decision of his, eight `sheet-verified` rows correctly tripped the
map guard ("overwrites a mapping decision of yours") and were released via
`sos_map_guard_decide(id,'approved',…)` quoting his words. Pre-image
`is_twin_backup_20260911.bab_elsheria_pre`.

⚠ **`B17-28` now shows 0 customers but still 183 `source_of_sales_import_rows`, and that is CORRECT, not
residue.** Import rows carry the geography STAMPED at import, so past months keep crediting Cairo East 1
and the ruling takes effect from the next import. A "0 customers but N sales rows" state is
**forward-only — do not reconcile it.** `B17-28` keeps its suffixed name as a marker; do not delete it.
