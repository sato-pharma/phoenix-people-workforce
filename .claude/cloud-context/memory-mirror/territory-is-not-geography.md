---
name: territory-is-not-geography
description: "SUPERSEDED 2026-09-13 by the owner's own method: remap territory FROM SCRATCH with the distributor-sheet ADDRESS as source #1 -> brick -> area; a pharmacy's confirmed place beats the distributor's district label; Sohag/Qena label rules. Older history below (0-for-5 on 09-08, address sheets reverted 09-11) explains why each move is still put to him to confirm region by region. Behira is CORRECT; Down town sits in Cairo via areaGovernorateOverrides."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 080edadf-6661-4200-922d-3f950d42addd
  modified: 2026-09-13T20:14:53.997Z
---

🔴 **2026-09-13 (evening) — OWNER METHOD, supersedes the "never from the address" rule below.** After
Upper Egypt's field-check rounds showed 637 of 861 wrong pharmacies sitting in a governorate CITY brick
because 11 distributor district labels (MARAKEZ SOHAG KEBLY, اسيوط, قنا ...) were aliased to that city
brick and every upload's self-heal rewrote the map to match, he said: *"Let's start remapping from
scratch... the address in the distributor sheet is your number one source of trust. From the address,
map to bricks. And bricks to areas."* Same day, in answer to multiple-choice questions:
- **A pharmacy's CONFIRMED place beats the distributor's district label**; the label only places new or
  unconfirmed pharmacies. (Code today lets a brick-alias hit return BEFORE the customer map, even at
  confidence 100 — `resolveBrick` in `src/lib/sales/normalizer/resolvers.ts` — so this needs a change.)
- **Label rules:** MARAKEZ SOHAG BAHARY and سوهاج → Sohag1; MARAKEZ SOHAG KEBLY → Sohag2; MARAKEZ QENA
  BAHARY → Qena 1; MARAKEZ QENA KEBLY → Qena 2. Bare قنا left open (100 of 142 pharmacies, 780k EGP
  Jul+Aug, are in Qena 1).
- His 974 Upper Egypt answers (xlsx/territory-fixes-2026-09-13) are confirmed places.
**How to apply:** the 3,742 are APPLIED (see below) — do NOT re-apply; the 30 held store/hospital rows are still open.
**Late 09-13 — method PROVEN and the list is built.** He said he does not want to confirm row by row. An
address-only matcher (town named in the address, INSIDE the pharmacy's current region, one area) was
right on your UE answers 748/767 and the old audit 29/29; he then confirmed a 50-row RANDOM spot check
(`address-spot-check-50-2026-09-13.xlsx`) as all correct. Street-only, city-only and OTHER-region town
hits are unreliable (other region 2 of 14) — never move on those. Keys proven wrong: نجع الدير(الدير),
باجا(اجا سوهاج), اولاد الياس. Final list `territory-changes-all-regions-2026-09-13.xlsx` + `changes_v2.csv`
(xlsx/territory-fixes-2026-09-13; scratch table `sos_analysis_20260913.changes_v2`): 3,742 to apply,
30 store/hospital names held. Re-stamp of existing import rows is `phx_sync_sos_run` — it reads the
customer map directly, NOT resolveBrick; locked periods are blocked by DB triggers. ~2,428 map rows carry
guarded sources, so the write is held until released via `sos_map_guard_decide`.
**APPLIED 2026-09-13 ~23:00 Cairo, on his "July and August are unlocked, apply the 3,742 changes".** Map:
3,742 rows at new brick, source `owner-address-remap-2026-09-13`, confidence 100 (1,326 direct + 2,416
guard holds released as B-10; 0 pending). Jul/Aug import rows: 5,858 moved (brick, block, area, region),
14 batches rebuilt (5 SQL rollups, then store-split net → attribution → summaries via
`refresh_split_attr.ts`). Proof: every line×month closing total unchanged (CNS July +0.67 EGP on one
Ramco product, same units, untraced); 175 area cells moved ~152K EGP; attribution 585 rows changed.
Pre-images in schema `sos_backup_20260913` (customer_map_pre, import_rows_pre, attribution_rollup_pre,
closing_pre/closing_post) — keep until Jul/Aug are relocked and settled. He must RELOCK Jul/Aug himself.
Did NOT use `phx_sync_sos_run` (it re-stamps every drifted customer, not just ours).
🔴 **OWNER RULE 09-13: Ibn Sina (`IS`, outsource products) and Ibn Sina-Sato (`IS-S`, Sato products) are ONE
distributor — the same customer code is ONE pharmacy and must NEVER sit on two bricks.** On a split, trust
the copy whose ADDRESS names the place; else the distributor's `Brick Name` label; tie-break Ibn Sina's brick.
Applied 09-13 (after the 3,742): 154 split pairs → 0 (155 map rows moved, source
`owner-ibn-sina-twin-2026-09-13`, both copies conf 100; 76 Jul/Aug rows; 4 batches rebuilt). Pre-images
`sos_backup_20260913.is_twin_map_pre` / `is_twin_rows_pre` / `attribution_rollup_pre2` / `closing_pre2`;
list `xlsx/territory-fixes-2026-09-13/ibn_sina_twin_audit.csv`. Any future remap must move both copies together.

**The address a distributor sends is not evidence of which AREA a customer belongs to.** Territory is
an owner decision; geography is not. A pharmacy whose address says منفلوط sitting in Assuit 2, or one
whose address says طنطا sitting in Gharbia 2, is the territory working as intended.

Measured 2026-09-08. The owner listed five pharmacies as "mapping is incorrect" and I diagnosed all
five by matching the address town against `source_of_sales_bricks`, then applied it. He then gave the
correct areas and **all five were the ORIGINAL mapping** - my sweep scored **0 for 5**:

| Code | Address says | Owner's area | I wrongly moved it to |
| --- | --- | --- | --- |
| `0001556619` | الباجور | Menoufia 1 | Menoufia 2 |
| `368210` | منفلوط | Assuit 2 | Assuit 1 |
| `361124` | قطور | Gharbia 1 (Tanta) | Gharbia 2 |
| `360848` | طنطا | Gharbia 2 (Mahalla) | Gharbia 1 |
| `0001501762` | الجمالية | Down town | Dakahlia 3 |

⚠ **`CA5` is NAMED "Down town", not "Cairo 5".** Deriving an area's label from its CODE instead of
reading `public.areas.name` is what made the fifth look like a Cairo/Dakahlia mix-up when it was
already right - and it is why a session can "confirm" its own wrong diagnosis. Always read the name.

**Why:** a wholesaler sells outside its own town, a rep's territory is drawn around people and not
around map boundaries, and the same pharmacy name recurs in every governorate - so an
address-versus-area disagreement is the NORMAL state, not a defect class. A repo-wide sweep built on
that premise flagged 2,138 "defects" whose founding five were all correct; it was closed unmerged
(PR #3548) and the whole production change set had to be reverted.

🔴 **The منفلوط example is about the ADDRESS, not the BRICK - and confusing the two raises a false
alarm in the opposite direction.** Both of these are true at once and neither is a defect:

- customer `368210` الشعب, whose **address** reads منفلوط, belongs to **Assuit 2** on brick
  `B181-1 مدينة أسيوط` - the owner's ruling of 2026-09-08, still live;
- the **brick** `B133-5 منفلوط` sits in **`UE3` Assuit 1**, and **40 customers whose Ibn Sina
  district text reads `MARAKEZ ASSIUT BAHARY` are deliberately mapped onto it** - 33 already carried
  an owner ruling at confidence 100 before 2026-09-11, and the owner confirmed the rest that day in
  three words: *"منفلوط, Assuit 1"*.

Measured 2026-09-11: a session read this file's Assuit 2 line, saw four customers resolved onto the
منفلوط brick against a distributor district of Assuit Bahary, and escalated it to the owner as
contradicting his own ruling. It contradicted nothing. **Before flagging a منفلوط row, check whether
you are looking at the address or the brick, and count how many customers on that brick already carry
`confidence = 100`** - a large owner-ruled population on a brick IS the ruling. The mechanism, and
the ~97% distributor-district test that settles this class of question, are in
[[an-owner-ruling-only-binds-at-confidence-100]].

🔴 **What to build INSTEAD of an address sheet, and the shape of the answer.** Measured 2026-09-11
on a 437-pharmacy shortlist another session had built by matching an address town to an area. The
owner's verdict on the top-20 table drawn from it was *"this is totally wrong"*, and he was right:
row 2 was عباسية كوم امبو, whose own NAME says Kom Ombo, correctly on Aswan, flagged as belonging to
Cairo East 1 because the word العباسيه also names a Cairo district.

The replacement is the **distributor's own territory column** (`source_of_sales_import_rows.raw_row`,
`Sal. Dist. Desc.` for PS, `Brick Name` for IS/IS-S, and so on), resolved through
`source_of_sales_territory_aliases` then `source_of_sales_area_aliases` with the repo's own
`normalizeAliasKey` - never `phx_normalize_arabic`, which MANUFACTURES alias hits production cannot
produce. Same 437 rows:

| | rows |
| --- | --- |
| the distributor's territory agrees with the area it is on | 128 |
| disagrees | 6 |
| distributor sent no usable territory - method stays silent | 303 |

**All 6 disagreements were already closed**: 4 sat on rows the owner had personally ruled, and the
other 2 sold only in locked months. **So the correct output of that entire exercise was zero
questions** - 292 address-derived "rulings" collapsed to none. When an address sheet and this method
disagree about how much work there is, the address sheet is the one that is wrong.

Where the distributor sends nothing, **stay silent rather than guessing** - and split the residue by
`official_line` before quoting its value: of the 303, 101 had no 2026 sales at all, half the rest sat
in locked months, and three quarters of what remained was Head Office, which reaches no closing. The
method is in the `sato-brick-area-mapper` skill; run its `resources/verify.sql` first.

🔴 **2026-09-11: the SAME question, asked again, went the OTHER WAY — so this file is about ASKING,
not about the address always being wrong.** Overnight he endorsed roughly 24 address-derived moves,
answering "Move it as proposed" on all 21 rows of a decision sheet and then, on three that had
replaced rulings of his own from July and August, saying plainly: *"BUT TEH MOVED TO IS CORRECT"*.
Those three carried Menoufia addresses (شبين الكوم, كفر داوود) and had been sitting in Alex Center,
Imbaba Centers and Behira 1; they now sit in Menoufia and he confirmed that is right.

**Read that against the 0-for-5 above rather than instead of it.** On 2026-09-08 the answer was
"leave all five"; on 2026-09-11 it was "move all of them", including three that reversed his own
earlier rulings. The constant is not which way he answers — it is that HE answers. So:

- **Never move a customer because the address says so.** Both dates agree on that.
- **But never conclude an address/area disagreement is fine either**, and do not refuse to surface
  one. That reading of this file would have suppressed 24 corrections he actually wanted.
- **A ruling of his can be superseded by a later ruling of his.** Three August rulings were reversed
  here. An `owner-*` stamp means "he decided this once", not "this is settled forever".

**How to apply:** when the owner reports a mapping as wrong, **ask him which area it should be** -
per [[sos-owner-standing-rules-from-session-369dd08d]] and the standing XLSX-with-dropdowns rule -
and change nothing until he answers. Do not infer an area from an address, a brick name, GPS, or your
own map of Egypt; [[address-matching-beats-paid-ai-and-geocoding-hurts]] says the brick table
outranks your map, and this says the OWNER outranks the brick table. Take a pre-image before any such
change: the full revert here was provable only because one existed. See also
[[sos-duplicate-brick-names-are-decoys]] and [[brick-area-is-the-blocks]].

🔴 **2026-09-12 — two rulings, and the second one is the pattern working.** Both were asked, neither
was inferred.

- **"Behira" is CORRECT — there is nothing to fix.** A prior session's note described a "Behira /
  Beheira collision" in the recruitment area keys. **Measured: it does not exist.** `areaFolderKey`
  (`src/lib/recruitment/district-manager-folders.ts`) keeps digits, so `behira1` ≠ `behira2`, and all
  40 live area names key uniquely; both halves already resolve to the governorate `Beheira` through
  the existing `behira` alias. The owner then ruled it twice in his own words — *"no iyt behira
  correct"*, then *"i am telling you behira is correct donot move to cairo"*. **Do not "fix" either
  Behira area, and do not re-raise the collision.**
- **"Down town" DOES sit in Cairo.** Area `CA5`, the only one of the 40 whose name resolved to no
  governorate at all. Owner: *"downtown move top cairo yes"*. Implemented as
  `areaGovernorateOverrides` in `src/lib/recruitment/cv-address-place.ts` — an AREA-scoped map, not a
  new address alias, so the place vocabulary is untouched. It matters because
  `position-suggestion.ts` exempts a last-remaining seat from the address check when its area has no
  governorate; Down town was falling through that exemption.

🔴 **2026-09-13 — the 11 Sep `distributor-territory-column` sweep replaced 34 of his 6 Aug rulings;
he split them 5 / 29, and both halves are SETTLED.** Asked after the August Anti Infective closing:
- **Five الباجور-area PS pharmacies go back to Menoufia 2** (`0001577025` تامر موسى, `0001582072`,
  `0001570629`, `0001581289`, `0001581179`) — *"restore all four"*. Restored, pre-image in
  `sos_backup_20260913`.
- **The other 29 (44 map rows: Assuit 1→2 ×11, Sohag2→1 ×6, Gharbia, Qena, Cairo East, Alex Center→
  Alex East, Nasr City→Down town, …) KEEP the sweep's area** — *"NO THOSE ARE CORRECT"*. Re-stamped
  `owner-ruling`/100 with areas untouched (`source = owner-ruling-2026-09-13-kept-sweep-area`).
  **Never offer to restore them, and never read "sweep overwrote an owner ruling" as a defect class.**

🔴 **2026-09-13 — Ibn Sina's `Brick Name` column is a SALES GROUPING, not a place — and the IS/IS-S
import profile reads it as the territory.** `ZEFTA` covers pharmacies whose `Territory Name` column says
GHARBIA TANTA, GHARBIA III ELSANTA, BASIUN, DAKAHLIA I ELMANSOURA, NASR CITY and SHARKEIA III HUSSEINIA;
`NASR CITY` and `CAIRO ( EL SALAM )` each span 13-16 territories. The alias `ZEFTA → B192-5 زفته (Mahalla)`
put 41 pharmacies counted in Tanta in August onto Mahalla on the map (40,438 EGP Jul+Aug). A brick
alias hit returns BEFORE the customer map in `resolveBrick`, so even a confidence-100 ruling may not beat
it at import. Settled nothing: the owner was sent `customer-area-mismatches-2026-09-13.xlsx` (115 rows, not
owner-ruled). **Wait for his sheet; never pick Territory Name over Brick Name yourself.**

**Why:** the two arrived in the same breath and went opposite ways, which is the whole point of this
file — the constant is that HE answers, not which way the answer goes. Measuring first is what kept
the Behira "fix" from being made.

**How to apply:** an area whose NAME carries no governorate gets an entry in
`areaGovernorateOverrides` once the owner has ruled on it — never a new entry in
`src/lib/geo/egypt-locations.ts`, which would let an address gazetteer decide where a territory sits.
Pinned by `runCvAddressPlaceTests`, including an assertion that no Behira area may ever be given one.
