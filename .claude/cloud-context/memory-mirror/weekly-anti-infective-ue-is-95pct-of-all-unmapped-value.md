---
name: weekly-anti-infective-ue-is-95pct-of-all-unmapped-value
description: "A missing area_code on a weekly row is mostly HARMLESS — CNS and Pedia run one flat UE so a region-only row still reaches the right manager; almost all value that reaches no seat is Anti Infective in UE, because only Anti Infective splits UE into UE-1/UE-2 while the branch→region map stamps one UE per branch. Measure loss as (line,region) pairs with NO seat in au_v_line_area_map, not null areas. OWNER SPLIT RULE (do not send a classification sheet): a depot splits evenly across the governorates its name names, then evenly across that governorate's areas — a multi-area depot is SPLITTABLE, not unmappable."
metadata:
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-09-26T00:46:01.168Z
---

## A null `area_code` on a weekly row is mostly harmless

Most weekly tracked-line value has no area ([[weekly-area-coverage-judge-by-value-not-rows]]), and that
figure invites a panic it doesn't deserve: **CNS and Pedia run a single flat `UE`, so a region-only row
resolves to the right manager fine.** The value that reaches **no seat at all** is almost entirely **Anti
Infective in UE**, because **only Anti Infective splits Upper Egypt into UE-1/UE-2**
([[aif-upper-egypt-splits-into-ue1-ue2]]) while the branch→region map is line-agnostic and stamps one `UE`
per branch for every line. 🔴 **When quantifying what weekly attribution actually loses, query for
`(line, region)` pairs with NO matching seat in `au_v_line_area_map` — never for null areas.**

## 🔴 The owner's split rule — never send a classification sheet for depot names

Weekly arrives from the distributor **by branch (a depot), not a territory**, so the depot NAME is the
only geographic signal. The owner's rule (he rejected a per-branch classification sheet and gave the rule
instead): a branch splits **evenly across the governorates its name names, then evenly again across each
governorate's areas** — "Minya and Assiut" is 50/50, so its four areas take 25% each; "Minya" alone is
UE1 50% / UE2 50%. **A depot serving several areas is not unmappable — it is SPLITTABLE**; leaving it
unmapped is what stranded the money. The split must be **shown in the weekly mapping sheet with its
calculation**, never applied silently.

Implemented in `src/lib/sales/weekly/branch-name-scope.ts` / `branch-area-split.ts`: it reads EVERY depot
name across CNS, Anti Infective and Pedia at **four grains — brick, area, governorate, region, most
precise first** — resolving per line from `au_v_line_area_map` (not a stored area list), because the same
governorate lands in different regions on different lines. **A hand-set Area on the mapping sheet OUTRANKS
the reading and is the owner's override** — the branch then sends its whole value there and its name is
not read at all.

## 🔴 Readings that are NOT obvious — do not "correct" them

- **"Alex-BHR" is read as a REGION, not Alexandria + Beheira.** The longest phrase in the name wins, and
  the region reading takes its areas from `au_v_line_area_map` — which is why it correctly pays the Kafr
  El-Sheikh areas the Alex-BHR manager holds; a governorate reading would miss them.
- **A bare "Delta" is deliberately unreadable** (names neither Delta 1 nor Delta 2 → the branch's own
  mapped region answers). Region NAMES that ARE unambiguous — Delta (1), Delta (2), Upper Egypt, Others,
  Alex-BHR — are read as regions.
- **A brick must be the WHOLE name** (`فرع قنا الجديد` is a depot in Qena, not the brick); a brick name
  living in two areas is dropped, never guessed. البلينا and ملوى are BRICKS (one area, no split) — and
  the brick table spells Mallawi `ملاوى` while the branch spells it `ملوى`, so a `%ملو%` search misses it.
- 🔴 **A depot number NEVER means an area number.** Alex areas are compass points (AB1 East, AB2 Center,
  AB3 West); AB3 matching a depot's "3" is coincidence. Same trap as "Alexandria 4", "Maryoutia 3".

## 🔴 Owner rulings that override every table

- **`AREA_SYNONYMS` (`governorates.ts`) has THREE warrants:** the district IS an area, the brick table
  files it in exactly one area, and **the owner ruled on that depot by name.** Entries marked `owner:`
  carry his words and the date and must **NOT** be re-"corrected" against `source_of_sales_bricks` — the
  brick table was never their source. Example: `ك.عملاء مطروح واسكن3` reached no area because مطروح is a
  real governorate no Phoenix area covers (reads, then drops out — indistinguishable from a name that read
  nothing) and `اسكن3` is too truncated to match `اسكندرية`. Owner: "Matrouh and Alexandria 3 = ALEX
  WEST" = **AB3**, registered as the WHOLE phrase (never a bare `اسكن3`/`مطروح`, which would match first
  and re-break it; depots 1/2/4 have no ruling and must keep reading Alexandria).
- **A private hospital's sales credit the AREA IT SITS IN** (owner ruling) — `hospital` was removed from
  the blocking `NON_TERRITORY_CLASSES` set but still **CLASSIFIES** (that is what stops `Assiut 2
  Warehouse` reading as a governorate). Warehouses and tenders stay blocked. Giza lands on `GZ1..GZ5,
  GZ7`; **GZ6 is Fayoum and is correctly not paid.**

## Durable process traps

- 🔴 **Dedupe by branch name before quoting any figure from `weekly_sales_branch_region_map`** — it holds
  DUPLICATE rows per depot, so summing over rows double-counts.
- **A comment that names a decision as the owner's is a TASK, not documentation.** The hospital money sat
  blocked "pending the owner's answer" that nobody had asked. Grep for that shape — "pending",
  "commercial decision", "once he rules" — and go ask.
- **Verify a phrase against ALL live mapping rows before shipping it** — that is what proves no bleed.
- **Never print a synonym / `placeAliases` key on a screen** — they are lowercase lookup tokens
  (`matrouh`, `kafr el-sheikh`), not display text; one reached the mapping sheet before being caught.
- **A test file that only EXPORTS its suite executes NOTHING when run directly** (node exits 0, looks
  green) — import the exported function and CALL it ([[a-regression-test-only-counts-if-you-break-the-fix]]).
- **Every non-territory class must state its reason at runtime** — an exhaustive `Record` won't gate the
  build (`next.config` sets `ignoreBuildErrors`), so a class added with no clause silently describes itself
  as a tender ([[an-exhaustive-record-does-not-gate-the-build-here]]).
