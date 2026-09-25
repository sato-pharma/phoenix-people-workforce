---
name: sos-duplicate-brick-names-are-decoys
description: "SoS brick-name twins are CLOSED: all five duplicate names were renamed with an area suffix on 2026-09-11, so every brick name is unique (verify.sql 33/84). The body's 'the empty twin is a decoy' reading went stale within hours — B200-5 held 70 customers, and B157-3 gained a real pharmacy in the Tahrir split — so never merge or delete a twin on a written count. Also: the TERRITORY ALIASES pointed at two twins until 2026-09-11, and the July 2026 remap resolved 13 vanished bricks BY NAME, moving 890 pharmacies, settled by the owner 2026-09-11"
metadata: 
  node_type: memory
  type: project
  originSessionId: f3deb2a3-78c9-4188-9750-0ce65dec6904
  modified: 2026-09-13T03:35:28.148Z
---

Exactly **four** brick names exist in more than one area, and in every pair **one twin carries all the
sales and the other carries exactly zero** — no units, no rollup rows, no customers mapped:

| Name | Real | Empty decoy |
| --- | --- | --- |
| الحامول | `B200-14` Kafr El-Sheikh 2 (1,570 u) | `B170-1` Kafr El-Sheikh 1 |
| بيلا | `B200-13` Kafr El-Sheikh 2 (966 u) | `B170-2` Kafr El-Sheikh 1 |
| فوه | `B199-9` Kafr El-Sheikh **1** (3,041 u) | `B200-5` Kafr El-Sheikh 2 |
| الخطاطبة | `B198-6` Imbaba (150 u) | `B157-3` Behira 1 |

**Why:** the brick picker shows the NAME and not the area, so the two are indistinguishable on
screen. On 2026-08-09 this cost real time — a customer was moved onto `B170-1` because a mapping
sheet's Brick ID column said so, even though the same sheet's Area Name column said Kafr El-Sheikh 2.
Note فوه runs the other way, so "the Kafr El-Sheikh 1 one is always wrong" is NOT the rule.

**How to apply:** when a brick id and an area label disagree, believe the AREA and look for the
same-named brick inside it. Before accepting any brick id from a sheet, check it against the area
written on the same row. Never delete the decoys ([[sos-areas-must-never-be-deleted-au-linkage]]).
Relocating a brick touches FOUR layers — see
[[moving-a-sos-brick-between-areas-needs-four-restamps]]; `source_of_sales_bricks` alone repoints
nothing, and `customer_map`/`import_rows`/`fact_rollup`/`customer_directory_rollup` each keep their
own stale `area_code`.

**Do NOT "fix" `customer_map.area_code` in bulk.** 901 of the 910 rows whose area disagrees with
their brick are the deliberate Fayoum (GZ6) / Beni Suef (UE9) split —
[[fayoum-beni-suef-golden-rule-per-line]]. Rewriting them would move 901 customers out of Fayoum in
one statement, and `phx_closing_customers` reads that column directly.

## 2026-09-11 — THE ALIAS TABLE IS A SECOND SURFACE, AND IT POINTED AT TWO DECOYS

A decoy holding **zero customers is still reachable**, because `source_of_sales_territory_aliases`
resolves a NAME for every future import. Measured: `بيلا` → `B170-2` and `حامول` → `B170-1`, both
retired in the 2026-08-06 Kafr El-Sheikh realignment and never repointed, so those two town names
resolved to a dead brick and **mapped nothing at all**. The full spelling `الحامول` was already
correct — only the article-less short form was broken, so "the town is broken" was too strong.
Repointed to `B200-13` / `B200-14`; pre-image `kes_alias_backup_20260911`. **After any brick
retirement, sweep the aliases too**: an active alias whose `target_code` is not an active brick is
the whole test, and it was 2 across 1,497 before this and 0 after.

Two indexes govern that table and neither is a constraint (`pg_indexes`, not `pg_constraint`):
unique `(normalized_alias, target_type, target_code)`, and unique `(normalized_alias, target_type)
WHERE active` — **one active alias per name**. So repoint IN PLACE; and where a retired row already
points at the destination, retire the live one FIRST and wake the old one, or the partial index
rejects the write.

## 2026-09-11 — THE 13 NAME COLLISIONS FROM THE JULY REMAP ARE SETTLED. DO NOT RE-OPEN THEM.

The 674→668 brick plan of 2026-07-24 left **14 live bricks uncovered**
([[reallocation-668-bricks-full-plan-live]]). Twelve were classed "direct reallocation" purely
because the old brick's name matched a brick in the new master, and the 2026-07-28 remap applied
them: **895 pharmacies changed AREA on a name match, with no address evidence recorded for any of
them.** The owner asked to decide them one at a time and only two were ever confirmed
(`B110-63`→`B149-16` سابا باشا, `B106-79`→`B5-64` شارع صلاح الدين — that one is **Heliopolis, not
Alexandria**, owner-confirmed twice).

**The remaining 11 were put to him as a dropdown sheet on 2026-09-11 and answered.** Ten: *keep it
in the new area*. One — `B28-47` باب الشعرية, Down town → Cairo East 1 — *put it back*. Applied:
brick `B28-47` recreated under block B28 (Down town), 17 pharmacies moved onto it, the five Bab
El Sharia aliases repointed there, and the **57** pharmacies across the ten kept bricks that had
since drifted elsewhere were aligned with the brick he kept. Pre-images
`bab_elsheria_backup_20260911` and `keep_bricks_backup_20260911`.

**Why this matters more than the detail:** a fresh audit re-derives these as "customers in the wrong
area" every single time — this session found all 895 from scratch without knowing the history. They
are now **owner decisions, not defects**. Never re-raise them, and never "fix" a kept row back
toward its address. Same trap as the finished SoS audit in `AGENTS.md` §4.

**A drifted row is sent to the brick its SIBLINGS use, never to the brick the July file named** —
four of those target brick ids no longer exist, because the master was replaced again on 2026-07-27
after the file was written, so following the file parks 23 pharmacies on a dead brick.

🔴 **THE SET OF FOURTEEN EXISTS IN EXACTLY ONE PLACE: the memory file
[[reallocation-14-uncovered-bricks]]**, which writes all fourteen ids out in a line. **Production
cannot reproduce the list and neither can the repository.** A brick with no customers appears in no
customer map, no pre-image and no rollup, and `B25-43` is additionally gone from
`source_of_sales_bricks` itself — verified 2026-09-11 at zero rows in the customer map (any state),
the brick table, `source_of_sales_import_rows` and `source_of_sales_territory_aliases`. It is a
MEMORY file, not a repo file, so `git grep` finds nothing and the answer looks unobtainable. Full
path when a peer session asks for it:
`C:\Users\satoh\.claude\projects\F--Phoenix-Workforce-phoenix-workforce\memory\reallocation-14-uncovered-bricks.md`.
This question has now been asked three times by two different sessions.

**FOURTEEN BRICKS, THIRTEEN RULINGS — the fourteenth is `B25-43` مديرية التحرير, and it is not a
missing decision.** It was the ONE of the fourteen that was never a name match: a legacy catch-all
needing a SPLIT BY ADDRESS across four real bricks (Badr, Sadat City, Kom Hamada, Buraijat), so it
formed no name-collision group and none of the 895. Verified on production 2026-09-11: absent from
`source_of_sales_bricks` entirely and holding **zero** `customer_map` rows, active or inactive. A
reader counting the ruling table against the heading finds 13 against 14 and reasonably asks —
answer that the heading counts BRICKS and the table counts RULINGS, and that the fourteenth carries
nothing. What is NOT provable from the rows is who applied its split or when; the July record has it
as proposed, never owner-confirmed.

🔴 **NEVER QUOTE A PER-BRICK ROW COUNT IN A DOCUMENT.** Section 5 of
`docs/source-of-sales-decisions.md` did, and was stale within the HOUR: another session moved two
more rows onto `B28-47` thirty minutes later, so a teammate reconciling the file against production
found it off by two in BOTH directions and read it as a defect. Counts were stripped from that file
on 2026-09-11 and a note added saying where to get them live. The crosswalk is written continuously
by several hands — put the RULING in a document and ask production for the numbers.

## 2026-09-11 evening — THE "ONE TWIN IS EMPTY" RULE IS NOW FALSE FOR MOST PAIRS

🔴 **Do NOT act on the table at the top of this file as if the empty twin is still empty.** It was
true when written. Measured again the same day, only **two** of the pairs still have a zero twin:

| Name | State now |
| --- | --- |
| `الحامول` | still one-sided — `B170-1` is 0 customers / 0 sales |
| `بيلا` | still one-sided — `B170-2` is 0 customers / 0 sales |
| `فوه` | 🔴 **BOTH LIVE** — `B199-9` 238 customers / 870 sales, `B200-5` **70 / 446** |
| `الخطاطبة` | `B157-3` is no longer empty — 1 customer / 1 sales row |
| `باب الشعريه` | **a FIFTH pair, not in the table above** — `B17-28` 18 customers / 183 sales, `B28-47` 19 customers / 0 sales |

**So a session that reads "the decoy carries exactly zero" and deletes or merges `B200-5` destroys
70 live customers and 446 sales rows.** The customers on it were put there partly by the owner
(`sheet-verified`, `owner-sheet-propagated-to-twin-2026-09-10`) and partly by
`distributor-territory-2026-09-11`. **Ask production for the counts; never trust the table above.**

**`فوه` was RENAMED rather than merged, owner 2026-09-11: `B200-5` is now `فوه - كفر الشيخ 2`.**
Both `brick_name` and `normalized_brick_name` were set. This follows the convention already in the
data — `B209B-1` is `مدينة قنا - قنا 2` against `B209-1` `مدينة قنا`. Renaming touches NOTHING else:
territory aliases point at `target_code`, not names, so both aliases still resolve (`فوه` → `B199-9`,
and the distributor's own `FOHA - MOTOBAS` → `B200-5`). Pre-image of all ten duplicate-name rows:
`is_twin_backup_20260911.bricks_pre`.

⚠ **The rename disambiguates the PICKER; it does not decide any mapping.** A pharmacy whose address
says `فوه` can still legitimately belong to either brick — the two are adjacent halves of the same
town across an area boundary, which is exactly why the distributor calls `B200-5` "FOHA - MOTOBAS".
Four duplicate names remain (`الحامول`, `بيلا`, `الخطاطبة`, `باب الشعريه`) and were deliberately left
alone: two are genuine empty decoys, and the other two need the owner before anything is renamed.

### The whole decoy problem is CLOSED — every brick name is now unique (owner, 2026-09-11)

All five pairs were disambiguated by RENAME. Nothing was merged, moved or deleted; every customer,
sales row and alias stayed exactly where it was. **The rule used: the twin that the plain-name
TERRITORY ALIAS already points at keeps the bare name, the other takes an area suffix** — the
resolver's own answer, not a judgement.

| Kept the bare name | Renamed |
| --- | --- |
| `B200-14` الحامول (Kafr El-Sheikh 2) | `B170-1` → `الحامول - كفر الشيخ 1` |
| `B200-13` بيلا (Kafr El-Sheikh 2) | `B170-2` → `بيلا - كفر الشيخ 1` |
| `B199-9` فوه (Kafr El-Sheikh 1) | `B200-5` → `فوه - كفر الشيخ 2` |
| `B198-6` الخطاطبة (Imbaba) | `B157-3` → `الخطاطبة - البحيرة 1` |
| `B28-47` باب الشعريه (Down town) | `B17-28` → `باب الشعريه - القاهرة شرق 1` |

⚠ **`باب الشعريه` is the one where the two signals DISAGREED and the alias won.** `B28-47` keeps the
bare name because five aliases point at it, yet it carries **zero** sales rows, while the suffixed
`B17-28` carries 183. If a picker should show the earning brick first, that pair is the one to flip —
it is a one-line rename either way and nothing else depends on it.

So the ORIGINAL hazard at the top of this file — *the picker shows the name and not the area, so the
two are indistinguishable on screen* — no longer exists. **Do not "restore" a bare name.** Pinned by
`verify.sql` check 84, which asserts ZERO brick names are used by more than one brick, and check 85,
which asserts `B200-5` keeps its suffix. Pre-image: `is_twin_backup_20260911.bricks_pre` (10 rows).

### 🔒 OWNER RULING 2026-09-11: "bab el sheria DOWNTOWN"

**باب الشعريه belongs to Down town (`CA5`), not Cairo East 1.** The pair was the one where the alias
and the sales disagreed — and the ALIAS was right. All **18** customers were moved off `B17-28`
(Cairo East 1) onto `B28-47` (Down town), which already held all five aliases. `B17-28` is now empty
and keeps its suffixed name as a marker; do NOT delete it
([[sos-areas-must-never-be-deleted-au-linkage]]).

**Eight of the 18 were `sheet-verified` and the guard held every one** — "overwrites a mapping
decision of yours" — correctly, because this ruling SUPERSEDES an earlier decision of his. Released
via `sos_map_guard_decide(id,'approved',…)` quoting his words. Pre-image:
`is_twin_backup_20260911.bab_elsheria_pre` (18 rows).

⚠ **`B17-28` still shows 183 `source_of_sales_import_rows`, and that is CORRECT, not residue.** Import
rows carry the geography STAMPED at import, so past months keep crediting Cairo East 1 and the ruling
takes effect from the next import. A session seeing "0 customers but 183 sales rows" must not try to
reconcile it — see the forward-only rule in the skill's twin-feed repair section.
