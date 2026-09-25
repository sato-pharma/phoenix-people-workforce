---
name: reallocation-14-uncovered-bricks
description: "14 live production bricks not covered by Locked_Area_Brick_Block_Reallocation.xlsx (the 674->668 brick reallocation plan) — owner is confirming their resolution one at a time before the plan is applied to production."
metadata: 
  node_type: memory
  type: project
  originSessionId: 13d2cbc9-99e8-4d8f-b6cc-e899420ca975
  modified: 2026-07-24T02:59:26.576Z
---

Part of the larger 668-brick reallocation project (see [[area-unification-42-areas-design]]-adjacent
work; the reallocation plan itself and the MAP-folder customer-remap audit are a separate, paused
thread — see `Phoenix_Customer_Remap_VERIFIED.xlsx` on Desktop and this session's earlier deep audits).
14 of the ~439 live production bricks are not addressed anywhere in the reallocation plan, so they'd
be silently orphaned if the plan were applied as-is: B110-63, B14-19, B14-20, B28-47, B52-35, B68-10,
B7-69, B76-35, B78-28, B78-32, B81-47, B92-26, B106-79, B25-43.

**Why this matters:** the plan is not yet applied to production (still paused, gated on an explicit
"ابدأ" from the owner). Before it can be, every one of these 14 needs a decided fate — direct
reallocation to an existing target brick, a genuine split, or a new brick added to the target master.

**Working classification (relayed by the owner from a parallel session's analysis, then independently
verified by me against live data — 439-live-brick export, the 49,712-row `source_of_sales_customer_map`
with real customer_name/address text, and my own previously-verified 668-brick target master):**
- 12 are simple DIRECT_REALLOCATION (old brick's name matches an existing target brick's name
  exactly/near-exactly).
- B106-79 ("شارع صلاح الدين") — my initial address-text read said Alex East, distinct from B5-64
  (also "شارع صلاح الدين" by name, Heliopolis); **owner overrode this, confirmed it IS Heliopolis** —
  see the dedicated paragraph below, this is the one place the relayed classification's *conclusion*
  (not just a target-ID typo) needed correction.
- B25-43 ("مديرية التحرير") is a legacy catch-all needing SPLIT_BY_ADDRESS, not a 1:1 move — verified by
  keyword-tabulating all 87 real customer addresses: ~41 Badr Center, ~26 Sadat City (target B69-11,
  which already exists both live and in the 668 master — no new brick needed for this slice), ~4 Kom
  Hamada, ~1 Buraijat, 2 genuine Cairo outliers (one literally says "عين شمس", one says "ميدان التحرير -
  قصر النيل" — a *second* independent Tahrir-name collision, same pattern as B106-79), remainder
  (~14 rows) have truncated/abbreviated addresses that need a per-row look rather than auto-classifying.

**One real error found and corrected in the relayed classification:** the claimed target for
`B110-63` (سابا باشا) was `B105-101` — **this brick ID does not exist anywhere in the 668-brick target
master** (block B105 is real, Alex East, but only goes up to B105-98; no -101). The actual "سابا باشا"
brick in the 668 master is **B149-16** (block B149, "سابا باشا – جليم – لوران", also Alex East) — a
different block than claimed, presumably a typo/mismatch in whatever produced the original list. This
is exactly the kind of claim the owner's verification standard exists to catch (see
grounded-recommendations-adjacent: never trust a relayed classification without checking it
against real data) — 11 of the 12 direct-reallocation claims checked out exactly as stated; only this
one had a wrong target ID.

**Process: going one at a time.** After an initial bulk verification report, the owner asked to go
through findings one problem at a time rather than as a big report — confirm each individually before
moving to the next, since a wall of findings at once was hard to track. The running decision log lives
at `scratchpad/14_bricks_confirmed_decisions.md` in the session's temp scratchpad (not durable across
machine/session cleanup — this memory file is the durable copy of what's been decided). **Confirmed by
owner so far: #1 only — `B110-63 -> B149-16`.**

**B106-79 — owner overrode my recommendation, CONFIRMED: MERGE into B5-64 (Heliopolis), not kept
separate.** I'd dug into why it's uncovered — the plan's "Block Comparison" sheet describes block B106
as having exactly 2 bricks (matching B106-80 حجر النواتيه + a target-master sibling), and B106-79 does
not appear anywhere in the plan's own 674-row old-brick-id list, proving the plan's source data never
had visibility into it — and initially recommended keeping it as its own Alexandria brick, based on
customer-address text (one address mentioned "كليوباترا"). **The owner pushed back twice, stating with
certainty this is actually Heliopolis.** On re-examination the address evidence was genuinely mixed, not
one-sided as I'd first presented: one customer's own name field literally says "مصر الجديدة" (Heliopolis)
and one address says "السيوف" (an Alexandria-only district) — but "كليوباترا", my original headline
evidence, turned out to be a weak signal on reflection (a common pharmacy/hospital brand name used
nationwide, not Alexandria-specific — I had over-weighted it). Surfaced the conflict and the mixed
evidence to the owner explicitly and asked whether they had ground-truth territory/rep knowledge; they
confirmed yes, twice. **Deferred to the owner's direct knowledge over inconclusive address-text
inference — this is the correct call**, not a case for continued pushback: address text is circumstantial
evidence, the owner has (or can get) authoritative rep/territory assignment. Worth a quiet later sanity
check on whether B106-79's own AB1/Alex-East live-master tagging is itself stale, but that does not
block this decision. **Lesson for this whole reallocation thread:** my own inferences from customer
address text are a useful FIRST pass, not a substitute for the owner's ground truth when the two
conflict — surface the conflict with the concrete evidence (as happened here), but don't keep re-arguing
past a clear, repeated owner correction.

**B25-43 full split built (proposed, not yet owner-confirmed):** `scratchpad/b25_43_split_proposal.csv`
— all 87 customers classified. Confirmed real target bricks: Badr Center -> **B157-2** بدر, Sadat City
-> **B69-11** مدينة السادات (already existed), Kom Hamada -> **B156-2** كوم حمادة, Buraijat ->
**B156-3** البريجات (Kom Hamada+Buraijat share block B156 in the target master, consistent with real
customer addresses naming both together). Result: 79/87 resolved (44 Badr, 31 Sadat, 3 Kom Hamada, 1
Buraijat — including a handful triangulated via a village name, e.g. "قرية المعركة", appearing paired
with "مركز بدر" 5+ times elsewhere in the SAME 87 rows, not a literal per-row keyword match). 3 rows are
genuine cross-governorate exceptions that must NOT go into this split (1 Cairo/Ain Shams, 1
Cairo/Tahrir-Square — a second, independent Tahrir name-collision matching the B106-79/B5-64 pattern —
1 Ismailia/Tal-El-Kebir). 5 rows are genuinely unresolvable from the data available (truncated address
field at the source, 3x an ambiguous "قرية النجاح" village, 1 other ambiguous village, 1 blank) — a real
data limit, not something to keep digging at without an external gazetteer.

**Next:** put the B25-43 split proposal to the owner (same pattern as #1 and #13), then continue
confirming the remaining 11 direct-reallocation rows — all already verified with no issues, just not
yet individually signed off. **Confirmed so far: #1 (B110-63->B149-16) and #13 (B106-79->merge into
B5-64).** — superseded by the full-plan execution below; the 14-fix is a closed chapter, all 14 are
now folded into the same live 668-brick state as everything else.

**2026-07-24 — owner said "neglect customers now and set the master database tables".** Built
`Phoenix_New_Master_Tables_FINAL.xlsx` on Desktop: a clean, review-ready deliverable containing ONLY
Region Master (7, unchanged from live — verified zero drift), Area Master (42, unchanged — same
verification), Block Master (168 rows, real column names: block_code/description/area_code/region_code/
active), Brick Master (668 rows, same real-schema shape), and a "14 Uncovered Bricks" sheet capturing
the structural resolution decided above (NOT customer data — old/new brick+block codes only). Explicitly
scoped out (per "neglect customers"): the customer_map remap, and the full original-plan brick-level
retirement crosswalk for the ~438 previously-covered live bricks (that's a separate ask if wanted later
— the plan's own "Brick Comparison" sheet has it). Confirmed before building: all 14 previously-uncovered
bricks resolve into brick IDs that ALREADY exist in the 668 set, so the 668/168 totals needed zero new
rows — this file's Block/Brick Master content was in fact already correct from the earlier
`Phoenix_Customer_Remap_VERIFIED.xlsx` build; this pass mainly repackaged it cleanly without the
customer sheet, plus the two Read Me sheets differ in scope on purpose (VERIFIED.xlsx documents the
customer remap methodology; FINAL.xlsx documents the master-tables-only scope). Was asked by the owner
whether this should write directly to production Supabase tables or produce a file for review first —
owner chose file-for-review (AskUserQuestion, 2026-07-24). Still nothing applied to Supabase.

**Mistake + fix, same day:** the first cut of `Phoenix_New_Master_Tables_FINAL.xlsx` only had a flat,
single Region Master (7 regions) — the owner immediately flagged this ("مش مقسم الـregions زي ما
قولتلك ليه" - you didn't split the regions like I told you). The miss: [[area-unification-42-areas-design]]
already established (and MEMORY.md's top-level index already recorded, BEFORE this session even started)
that `au.line_area_map` implements a genuine per-LINE operational region grouping over the same 42
areas — CNS / Pedia / Anti-Infective each have their own region assignment, and it is NOT just the
well-known UE->UE-1/UE-2 Anti-Infective split. Querying `au.line_area_map` live (production, read-only)
showed **16 of the 42 areas differ by line**: CA5, D11, D16, D25, GZ3, GZ5, GZ6, GZ7, and all 8 UE
areas — e.g. GZ6 (Fayoum-Beni Suef) is OT for CNS, GZ for Pedia, but UE-1 for Anti-Infective; CA5
(Downtown) is GZ/OT/OT across the three lines. Fixed by adding an "Area Region by Line" sheet (pivoted:
area_code/area_name/base_region_code/cns_region_code/pedia_region_code/anti_infective_region_code/
differs_by_line) sourced directly from `au.line_area_map`, and extending Region Master with UE-1/UE-2
(clearly noted as an Anti-Infective-only operational split, not new geography). **Lesson: having a fact
recorded in persistent memory is not the same as applying it — cross-check every master-data deliverable
against the FULL relevant memory context before calling it done, not just the live conversation thread.**

**Same day, follow-ups:** (1) owner asked to redesign the file to match the app's real master-data
export look — read `src/lib/sales/master-data/export-workbook.ts` (the "Phoenix visual language": black
title/subtitle/header bands, orange accents/grid, zebra data rows) and ported it into the Python build
script exactly (same hex colors, same row layout, same alternating-fill logic), rather than inventing a
new style. (2) owner said "never show only codes, always codes and names" (matches
[[feedback-show-names-not-codes]]) — every bare code column (region_code, area_code, block_code) now has
its name paired directly next to it in Area/Block/Brick Master and the per-line sheet, not just brick/
block's own identity columns. (3) owner asked whether the Area Master's single `region_code` could
confuse the system later — yes, confirmed as a real, already-once-hit risk (see the Territory Drilldown
lesson above), and CA5 is a concrete example where the base region (CA) doesn't even match ANY of the
3 real per-line operational regions (GZ/OT/OT) — added explicit ⚠ warnings to the Read Me and to every
sheet whose subtitle carries a `region_code` column, pointing to "Area Region by Line" as the correct
source for anything line-scoped. **File went through several redeploy cycles same day due to Excel file
locks** (the owner had it open while reviewing) — ended up as `_v2.xlsx`/`_v3.xlsx` beside the original;
next session should check which is newest before assuming the base filename is current.

**2026-07-24 — APPLIED TO PRODUCTION.** Owner said "خلاص انقلهم في أماكنهم" (move them to their
places) for the 14. Before executing, discovered the real scope was bigger than a 14-row flip: 16 of
17 target brick ids (all except B69-11) did NOT exist live yet, and 3 target blocks (B149, B156, B157)
didn't exist either — since the wider 668/168 plan itself has never been applied. Surfaced this exact
scope to the owner (3 new blocks + 16 new bricks + 14 deactivations, customer_map untouched, with the
known temporary side effect that customers still on the 14 old ids stop resolving in the next monthly
import until remapped) and got an explicit "ابدأ" for that specific plan. Executed directly via
`execute_sql` against project `ozucdzovmcqvepbozvqf` (production) — schema-checked both tables first
(`information_schema.columns`) and matched the exact existing manual-entry convention already used once
before in this table (`source_file = 'manual:d3_geography_rebuild_from_master'`, found by inspecting a
sample row) — this session's batch uses `source_file = 'manual:14-uncovered-bricks-resolution-2026-07-24'`,
`effective_from = '2026-07-24'`, same pattern. Result: 3 blocks inserted (B149/B156/B157), 16 bricks
inserted (the union of all 12 direct-reallocation targets + B5-64 + B157-2/B69-11/B156-2/B156-3), 14
old bricks deactivated (`active=false`). Wrote 3 `audit_logs` rows (block creation, brick creation,
brick deactivation) since raw SQL bypasses the app's own `writeAuditLog` call sites. **Live counts after:
441 active bricks (439-14+16, correct), 151 active blocks — NOT 145 (142+3) as expected**, meaning the
live block count was already at 148 before this change, not the 142 this whole thread had been assuming
from the original plan's own "142->168" headline stat. Never independently verified block count this
session before now; worth checking next session whether that gap is from other legitimate prior manual
work (plausible — same `d3_geography_rebuild_from_master` precedent suggests block-master edits outside
this plan have happened before) or something to look into. **customer_map is now explicitly stale for
these 14 old ids** — the B25-43 split proposal (`scratchpad/b25_43_split_proposal.csv`) and the direct
reallocations' customer moves are NOT yet applied; that remains the deferred next step whenever the
owner says go on customers.

**Same-day follow-up — the deliverable file lagged the production change and confused the owner.**
The xlsx was built BEFORE the production execution above, so its "14 Uncovered Bricks" sheet still
read as a pending proposal after the fact — owner (reasonably) flagged this as "why do these still show
as uncovered?". Separately, the owner also got confused seeing 441 bricks / 151 blocks live vs the
668/168 the file's main Brick/Block Master sheets show — those two numbers are NOT the same thing (441/151
is today's live count after only the 14-bricks fix; 668/168 is the full plan's eventual target, ~424
bricks + ~139 blocks of which are still untouched) and the file didn't make that distinction obvious
either. Fixed both: added a green ✅-highlighted Status column to the "14 Uncovered Bricks" sheet
(every row now says "APPLIED TO PRODUCTION 2026-07-24"), and added an explicit "✅ PRODUCTION STATUS"
paragraph to the Read Me spelling out live counts vs full target counts. **Lesson: after executing a
production change that a deliverable file was built to propose, update the file's status before
re-sharing it — don't just verbally confirm success while handing over a document that still reads as
an open proposal.** Also: this session's scratchpad got silently cleared partway through (noticed when
`build_master_tables_v2.py` and its CSV/JSON inputs were gone) — had to rebuild the script and re-pull
region/area reference data fresh from live Supabase instead of trusting the old CSV cache. Worth keeping
in mind that scratchpad contents are not guaranteed durable within a long session, let alone across
sessions — see [[localappdata-temp-is-live-tool-state]].
