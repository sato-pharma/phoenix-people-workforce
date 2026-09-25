---
name: weekly-anti-infective-ue-is-95pct-of-all-unmapped-value
description: "68.4% of weekly tracked-line value has no area but almost all of it is harmless - the ONLY line that loses money to it is Anti Infective in UE, and 23 named branches carry the whole remaining EGP 6.26M"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0ef3c838-df3a-4112-ac74-bca2e15e4f4b
  modified: 2026-08-27T00:00:00.000Z
---

**A missing `area_code` on a weekly row is usually harmless.** 68.4% of tracked-line value has no
area ([[weekly-area-coverage-judge-by-value-not-rows]]) and that number invites a panic it does not
deserve: CNS and Pedia run a single flat `UE`, so a region-only row resolves to the right manager
perfectly well. Measured live in production 2026-08-26/27, the value that actually reaches **no
seat at all** is EGP 10,723,950, and it is almost entirely one line in one region:

| line | region | EGP | share |
| --- | --- | --- | --- |
| **Anti Infective** | **UE** | **10,289,490** | **95.9%** |
| Pedia | `NATIONAL` | 326,660 | 3.0% |
| CNS / Pedia | blank | 107,800 | 1.0% |

Because **only Anti Infective splits Upper Egypt into UE-1/UE-2**
([[aif-upper-egypt-splits-into-ue1-ue2]]) while the branch→region map is line-agnostic and stamps
one `UE` per branch for every line.

## What PR #2436 recovers, and what it cannot

Of that EGP 10,289,490: **526 rows / EGP 4,027,715 already carry an area** and are recovered by
reading `au_v_line_area_map` (area beats region). **337 rows / EGP 6,261,775 carry no area** and
code cannot invent one — weekly arrives from the distributor **by branch**, a depot, not a
territory. It also corrects EGP 5,298,449 sitting on 15 `(line, area)` pairs whose area and region
disagreed.

## The remaining 6.26M is only 23 branches, and the OWNER GAVE THE RULE - do not ask again

I sent `xlsx/weekly-upper-egypt-branch-areas.xlsx` on 2026-08-27 asking him to classify all 23.
**He rejected the question and answered with a rule instead**, which is the durable fact here:

> a branch splits **evenly across the governorates its name names, then evenly again across that
> governorate's areas** - "Minya and Assiut" is 50/50, so UE1/UE2/UE3/UE4 take 25% each; "Minya"
> alone is UE1 50% / UE2 50%.

And two rows should never have been in the sheet at all: **البلينا and ملوى are BRICKS**, so they
map to exactly one area with no split (`B214-M1` -> UE6 Sohag2, `B204-2` -> UE2 Minia 2 - and note
the brick table spells Mallawi `ملاوى` while the branch spells it `ملوى`, so a `%ملو%` search
misses it). He also said the split must be **visible in the weekly mapping sheet with its
calculation**, not applied silently - and *"don't just send me data for nothing."*

Implemented as `src/lib/sales/weekly/branch-area-split.ts` (PR #2436, commit `5df3acd7`), which
resolves per line from `au_v_line_area_map` rather than from a stored area list, because the same
governorate lands in different regions on different lines. Run live 2026-08-27 the 23 branches
reallocate all EGP 6,261,774 with drift 0.000000 and nothing unresolved.

**Why:** the depot names are Arabic and the value is concentrated — `ك.ع.المنيا واسيوط` alone is
EGP 1,597,352, and one glance at it ("key accounts, Minya AND Assiut") explains both why it is
unmapped and why no code change can map it.

**How to apply:** never report the 68.4% no-area figure as a fault without this breakdown next to
it — most of it costs nothing. When quantifying what weekly attribution actually loses, query for
`(line, region)` pairs with **no matching seat** in `au_v_line_area_map`, not for null areas.

**The old advice here said a Key Account depot "is honestly unmappable, leave it unmapped." The
owner overruled that on 2026-08-27** — a depot serving several areas is not unmappable, it is
*splittable*, and leaving it unmapped is what stranded EGP 6.26M. Never send him a classification
sheet for depot names either; the split rule above already answers all 23.

## SHIPPED TO PRODUCTION 2026-08-27 - and it is far bigger than the 23 branches above

PR #2436 merged as `6590ca8e` and is live (`/api/healthz` confirmed serving it). What shipped is
**not** limited to the 23 Upper Egypt branches this note was written about. `branch-name-scope.ts`
reads EVERY depot name across CNS, Anti Infective and Pedia at four grains - brick, area,
governorate, region, most precise first - so the real production figures are:

| | EGP | |
| --- | --- | --- |
| now splits to areas, and therefore to reps | **55,319,105** | 152 branches |
| deliberately stays at region | 1,786,103 | warehouses, private hospitals, tenders |
| stays exactly where it was | 434,461 | no place in the name, region resolves to nothing |

**A hand-set Area on the mapping sheet OUTRANKS the reading and is the owner's override** - the
branch then sends its whole value there and its name is not read at all. The reading and its
arithmetic are displayed under every branch on the mapping screen and in two info-only columns of
the mapping workbook, which is his "show it with the calculation" instruction.

Three readings that are NOT obvious and should not be "corrected":

- **"Alex-BHR" is read as a REGION, not as Alexandria + Beheira.** The longest phrase in the name
  wins, and the region reading takes its areas from `au_v_line_area_map` - which is why it correctly
  pays the two Kafr El-Sheikh areas the Alex-BHR manager actually holds, and a governorate reading
  would have missed them entirely.
- **A bare "Delta" is deliberately unreadable** (EGP 900,983): it names neither Delta 1 nor Delta 2,
  so the branch's own mapped region answers instead. Region NAMES that ARE unambiguous - Delta (1),
  Delta (2), Upper Egypt, Others, Alex-BHR - are read as regions and recover ~EGP 5.9M.
- **A brick must be the WHOLE name.** `فرع قنا الجديد` is a depot in Qena, not the brick; a brick
  name living in two areas (بيلا, دار السلام) is dropped rather than guessed at.

**How to apply:** this note's "23 branches / EGP 6.26M" framing is now the SMALL case, not the
scope. Before quantifying weekly attribution loss again, re-measure - the answer moved by an order
of magnitude on 2026-08-27. And never print a `placeAliases` key on a screen: they are lowercase
lookup tokens (`matrouh`, `kafr el-sheikh`), which is a real bug that reached the mapping sheet
before being caught by rendering it against all 912 mapped branches.

## The owner PLACES a depot no table can place (2026-08-27, #2442)

`AREA_SYNONYMS` in `src/lib/sales/weekly/governorates.ts` now has a **third warrant** beside "the
district IS an area" and "the brick table files it in exactly one area": **the owner ruled on that
depot by name.** Entries marked `owner:` carry his words and the date and must **NOT** be
"corrected" against `source_of_sales_bricks` later — the brick table was never their source.

The case that created it: **`ك.عملاء مطروح واسكن3`** was the LAST branch in the weekly feed holding
real tracked money that reached **no area at all** — EGP 109,737 across CNS, Pedia and Anti
Infective. Both halves failed, for different reasons, and this is the pattern to recognise:

- **مطروح is a real governorate that NO Phoenix area covers.** It reads correctly, then drops out.
  A governorate with no area is indistinguishable from a name that read nothing.
- **`اسكن3` is too truncated to match `اسكندرية`.** Depots 1, 2 and 4 spell it in full and read the
  whole governorate; only 3 is cut short, which is why only 3 was broken.

He answered: **"Matrouh and Alexandria 3 ALEX WEST"** = **AB3**. Registered as the WHOLE phrase
(both spacings), never a bare `اسكن3` and never a bare `مطروح` — the bare governorate would match
first and re-break it, and depots 1/2/4 have **no ruling** and must keep reading Alexandria.

**AB3's number matching the depot's "3" is a COINCIDENCE.** The Alex areas are compass points
(AB1 East, AB2 Center, AB3 West); a depot number never means an area number — that is the same trap
as "Alexandria 4" and "Maryoutia 3". A note now sits on `GOVERNORATES_BY_AREA` saying so.

**Verify a phrase against all 912 live mapping rows before shipping it** — that is what proves no
bleed. Exactly 3 rows matched here, all reading `AB3:100.00`.

**A test file in `tests/` that only EXPORTS its suite executes NOTHING when run directly** — node
exits 0 and it looks green. Import the exported function and call it, or the "proof" is worthless.
This nearly shipped unverified; see [[a-regression-test-only-counts-if-you-break-the-fix]] in spirit.

## OWNER RULING 2026-08-27 (2) — a private hospital's sales credit the AREA IT SITS IN

`hospital` sat in `NON_TERRITORY_CLASSES` beside warehouses and tenders, so **EGP 1,091,946 of
tracked weekly value credited nobody**. The comment above that set had said for weeks that whether a
private hospital is the local rep's credit is a **commercial** decision, not a technical one — and
then left it blocked "pending the owner's answer" that nobody had asked for. He was asked and said
**yes**. PR #2445.

**A comment that names a decision as the owner's is a TASK, not documentation.** That is the lesson
worth keeping: the code knew exactly what question was outstanding and how much money rode on it,
and the question still went unasked. Grep for that shape — "pending", "commercial decision",
"once he rules" — and go ask.

- `hospital` still **CLASSIFIES** — that is what stops `Assiut 2 Warehouse` being read as a
  governorate. Only its membership of the blocking set went. Warehouses and tenders are untouched.
- `Del2` and `Upper` are the hospital depots' own spellings of a REGION. Registered so the sheet
  explains the branch instead of calling it unreadable; the money already landed via the region
  fallback. Both match those depots and **nothing else** among the 514 distinct branch names.
- **The mapping table holds DUPLICATE rows per depot** — 17 hospital rows are 12 distinct depots.
  Summing over rows double-counted and read EGP 1,635,091 instead of the true EGP 1,091,946.
  **Dedupe by branch name before quoting any figure from `weekly_sales_branch_region_map`.**
- Giza lands on `GZ1..GZ5, GZ7`; **GZ6 is Fayoum** and is correctly not paid.

Every non-territory class must state its own reason at runtime — an exhaustive `Record` would not
gate the build here (`next.config` sets `ignoreBuildErrors`), so a class added with no clause beside
it would silently describe itself as a tender. See
[[an-exhaustive-record-does-not-gate-the-build-here]].
