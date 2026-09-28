---
name: territory-is-not-geography
description: "Territory is an OWNER DECISION, geography is not — an address/area disagreement is the NORMAL state, never a defect class. Owner method 2026-09-13: remap from scratch with the distributor-sheet ADDRESS as source #1 -> brick -> area, and a pharmacy's CONFIRMED place beats the distributor's district label. Never move a customer because the address says so, and never conclude a disagreement is fine either — ASK him which area; a ruling can be superseded by a later ruling. The distributor's own territory column (not an address gazetteer) is the surface to measure; where it is silent, stay silent. CA5 is NAMED 'Down town' (in Cairo via areaGovernorateOverrides); Behira is CORRECT. Ibn Sina IS/IS-S is ONE distributor; its Brick Name is a sales grouping, not a place."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 080edadf-6661-4200-922d-3f950d42addd
  modified: 2026-09-26T01:34:19.745Z
---

## The principle — the constant is that HE answers

**The address a distributor sends is not evidence of which AREA a customer belongs to.** A wholesaler
sells outside its own town, a rep's territory is drawn around people not map boundaries, and the same
pharmacy name recurs in every governorate — so an address-versus-area disagreement is the NORMAL state,
not a defect. Both of these are the rule working, not bugs: a pharmacy whose address says منفلوط sitting
in Assuit 2, or one whose address says طنطا sitting in Gharbia 2.

Yet the answer goes both ways, and that is the whole point. On 2026-09-08 the owner listed five pharmacies
as "mapping is incorrect"; an address-town sweep moved all five, and he then ruled **all five were the
ORIGINAL mapping — 0 for 5.** On 2026-09-11 the same kind of question went the OTHER way: he endorsed ~24
address-derived moves, three of which **reversed his own July/August rulings** (*"BUT THE MOVE TO IS
CORRECT"*).

So: **never move a customer because the address says so** (both dates agree); **but never conclude an
address/area disagreement is fine either, and do not refuse to surface one** (that reading would have
suppressed 24 corrections he wanted). **A ruling of his can be superseded by a later ruling** — an
`owner-*` stamp means "he decided this once," not "settled forever." When he reports a mapping wrong,
**ask which area it should be** (in-chat multiple choice / the XLSX-with-dropdowns rule,
[[sos-owner-standing-rules-from-session-369dd08d]]) and change nothing until he answers. Never infer an
area from an address, brick name, GPS or your own map — [[address-matching-beats-paid-ai-and-geocoding-hurts]]
says the brick table outranks your map, and this says the OWNER outranks the brick table.

⚠ **`CA5` is NAMED "Down town", not "Cairo 5."** Deriving an area's label from its CODE is what made one
of those five look like a Cairo/Dakahlia mix-up when it was already right — always read
`public.areas.name`, or a session "confirms" its own wrong diagnosis. A repo-wide sweep built on "address
= area" flagged thousands of "defects" whose founding five were all correct; it was closed unmerged and
the whole production change set had to be reverted. **Take a pre-image before any such change — the revert
was provable only because one existed.**

## The owner method (2026-09-13) — address → brick → area

*"Let's start remapping from scratch… the address in the distributor sheet is your number one source of
trust. From the address, map to bricks. And bricks to areas."*

- **A pharmacy's CONFIRMED place beats the distributor's district label**; the label only places new or
  unconfirmed pharmacies. 🔴 Code today lets a **brick-alias hit return BEFORE the customer map**, even at
  confidence 100 (`resolveBrick`, `src/lib/sales/normalizer/resolvers.ts`) — so a conf-100 ruling may not
  beat an alias at import; **this still needs a change.**
- **Sohag/Qena label rules:** MARAKEZ SOHAG BAHARY & سوهاج → Sohag1; MARAKEZ SOHAG KEBLY → Sohag2;
  MARAKEZ QENA BAHARY → Qena 1; MARAKEZ QENA KEBLY → Qena 2. Bare قنا is left open (most fall in Qena 1).
- **The address-only matcher that proved out** (he does not want row-by-row confirmation): a town named in
  the address, INSIDE the pharmacy's current region, resolving to exactly ONE area — proven accurate on
  his UE answers and spot checks. 🔴 **Street-only, city-only and OTHER-region town hits are UNRELIABLE —
  never move on those.** Keys proven wrong: نجع الدير (الدير), باجا (اجا سوهاج), اولاد الياس.

## The distributor-territory-column method — measure this, not an address sheet

An address-town shortlist is the wrong tool (عباسية كوم امبو, whose NAME says Kom Ombo on Aswan, was
flagged for Cairo because العباسيه also names a Cairo district). The replacement is the **distributor's own
territory column** (`source_of_sales_import_rows.raw_row` — `Sal. Dist. Desc.` for PS, `Brick Name` for
IS/IS-S), resolved through `source_of_sales_territory_aliases` then `source_of_sales_area_aliases` with the
repo's own **`normalizeAliasKey` — never `phx_normalize_arabic`, which MANUFACTURES alias hits production
cannot produce.** On a real test this method produced **zero** real questions where an address sweep had
implied hundreds. **When an address sheet and this method disagree about how much work there is, the
address sheet is wrong.** Where the distributor sends nothing, **stay silent rather than guess**, and split
the residue by `official_line` before quoting its value (much of it is Head Office, which reaches no
closing). Method: the `sato-brick-area-mapper` skill; run its `resources/verify.sql` first.

## Ibn Sina rules

- 🔴 **Ibn Sina (`IS`, outsource products) and Ibn Sina-Sato (`IS-S`, Sato products) are ONE distributor —
  the same customer code is ONE pharmacy and must NEVER sit on two bricks.** On a split, trust the copy
  whose ADDRESS names the place; else the distributor's `Brick Name`; tie-break to Ibn Sina's brick. **Any
  future remap must move both copies together.**
- 🔴 **Ibn Sina's `Brick Name` column is a SALES GROUPING, not a place — and the IS/IS-S import profile
  reads it as the territory.** `ZEFTA` covers pharmacies whose `Territory Name` says GHARBIA TANTA, BASIUN,
  DAKAHLIA I ELMANSOURA, NASR CITY…; the alias `ZEFTA → B192-5 زفته (Mahalla)` put pharmacies counted in
  Tanta onto Mahalla. **Never pick Territory Name over Brick Name yourself — wait for his sheet.**

## The منفلوط address-vs-brick trap

Two things are true at once and neither is a defect: a customer whose **address** reads منفلوط belongs to
**Assuit 2** on a city brick (owner ruling, live); AND the **brick** `B133-5 منفلوط` sits in `UE3` **Assuit
1**, with ~40 customers deliberately mapped onto it (owner-confirmed). A session once escalated four
منفلوط-brick customers as "contradicting his ruling" — it contradicted nothing. **Before flagging a
منفلوط-type row, check whether you are looking at the ADDRESS or the BRICK, and count how many customers on
that brick already carry `confidence = 100`** — a large owner-ruled population on a brick IS the ruling.
Mechanism: [[an-owner-ruling-only-binds-at-confidence-100]].

## Two settled area-name rulings — do not re-raise

- **"Behira" is CORRECT.** The claimed "Behira / Beheira collision" in the recruitment area keys **does not
  exist** — `areaFolderKey` keeps digits so `behira1` ≠ `behira2`, and both halves resolve to governorate
  `Beheira` through the existing `behira` alias. Owner: *"behira is correct do not move to cairo."* Do not
  "fix" either Behira area or re-raise the collision.
- **"Down town" sits in Cairo.** Area `CA5` was the only area whose name resolved to no governorate. Fixed
  via `areaGovernorateOverrides` in `src/lib/recruitment/cv-address-place.ts` — an AREA-scoped map, NOT a
  new entry in `src/lib/geo/egypt-locations.ts` (which would let an address gazetteer decide where a
  territory sits). It matters because `position-suggestion.ts` exempts a last-remaining seat from the
  address check when its area has no governorate. Pinned by `runCvAddressPlaceTests`, which also asserts no
  Behira area may ever be given a governorate override.

## Status — the 09-13 remap is APPLIED, do not re-apply

The owner-address remap and the Ibn Sina twin-split fix were APPLIED to July/August 2026 on 2026-09-13 at
his instruction (every line×month closing total unchanged); a handful of store/hospital rows are held.
Pre-images live in schema `sos_backup_20260913` (keep until Jul/Aug are relocked and settled — **he
relocks the months himself**). Of his earlier rulings the 11-Sep sweep had replaced, he split them into a
**restore** set and a **keep-the-sweep-area** set, both halves SETTLED — **never offer to restore a kept
row, and never read "a sweep overwrote an owner ruling" as a defect class.** Re-stamping existing import
rows uses `phx_sync_sos_run` (reads the customer map, not `resolveBrick`; locked periods blocked by DB
triggers; guarded map sources release via `sos_map_guard_decide`).

Related: [[sos-duplicate-brick-names-are-decoys]] · [[brick-area-is-the-blocks]] ·
[[sos-owner-standing-rules-from-session-369dd08d]]
