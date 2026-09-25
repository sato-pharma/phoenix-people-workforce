---
name: sales-to-marketing-sync-creates-ambiguous-duplicates
description: "phx_sync_sales_pharmacy_codes_into_marketing() blind-inserted codes the spreadsheet imports already held under the same distributor, so 2 exact matches made the capture gate say 'ambiguous' instead of 'matched' — run on prod 2026-08-19 it flipped 44,244 codes and had to be deduped by hand. FIXED on prod the same day via PR #2224 + #2227 (FIVE defects, not one; the sync has since been RUN on prod twice and is a measured no-op) — verify with pg_get_function_result: old=2 cols, new=6"
metadata:
  node_type: memory
  type: project
  originSessionId: e57e90b1-6df8-4f5f-b57e-e8bd26ebf3a5
  modified: 2026-08-19T19:33:18.648Z
---

**`public.phx_sync_sales_pharmacy_codes_into_marketing()` had a live defect. IT IS FIXED ON
PRODUCTION as of 2026-08-19 — see the last section, and verify with `pg_get_function_result` before
relying on it.** Everything below describes the incident and the reasoning; it is history, not a
live hazard. The old `scripts/sync-sales-pharmacy-codes-into-marketing.ts` header invited you to
re-run it ("As Sales imports more distributors, re-run this") — that comment was the trap, and it
is gone.

**What goes wrong.** The function attaches synced rows to an existing `marketing_distributors` row
whenever `normalized_name` matches, so SoS rows for POS / Ibn sina / EGD / ramco / sofico / mec /
epda land on the **same `distributor_id`** as the spreadsheet rows. Both sources store the code in
the **same zero-padded form**, so the duplicate is on `normalized_pharmacy_code` — the exact column
PASS 1 of `resolvePharmacyCodeReference` matches on. And
`buildPharmacyCodeReferenceResult` ([service.ts:4300](src/lib/marketing-requests/service.ts))
reads `matchCount > 1 ? "ambiguous"`. Pass 2 never rescues it, because pass 2 only runs when pass 1
found **zero**.

The comment at service.ts:4363 called this shot in advance: *"no two distinct codes inside one
distributor share a zero-stripped key. Should an import ever create one, this returns 'ambiguous'
rather than guessing."* The sync is exactly that import.

**Ran on prod 2026-08-19, owner-approved.** Returned `distributors_created 9`,
`references_synced 52614` — and instantly put **44,244 codes into `ambiguous`**: POS 27,590,
Ibn sina 12,913, EGD 1,807, ramco 1,045, sofico 692, mec 141, epda 56. Caught within minutes and
repaired by deleting only the synced rows a pre-existing row already covered:

```sql
delete from public.marketing_pharmacy_code_references r
where r.source_file = 'source_of_sales_customer_map'
  and exists (select 1 from public.marketing_pharmacy_code_references o
              where o.distributor_id = r.distributor_id
                and o.normalized_pharmacy_code = r.normalized_pharmacy_code
                and o.source_file <> 'source_of_sales_customer_map');
```
44,244 deleted, **8,370 genuinely new rows kept**. Verified after: **zero** ambiguous pairs on either
`normalized_` or `compact_pharmacy_code`, all 16 distributors resolve a sample code to exactly 1,
both spreadsheets byte-for-byte intact (25,811 / 19,603), and all 311 `marketing_pharmacy_distributor_codes`
rows unchanged in both `reference_status` and `reference_match_count`.

**Net result, which WAS worth having:** distinct codes the gate can see went **45,379 -> 50,003**,
and live-map codes invisible to the gate went **4,624 -> 0**. Total rows 45,414 -> 53,784.

**The fix the function needed** — a `not exists` guard on `(distributor_id,
normalized_pharmacy_code)` before the insert, i.e. additive not blind — **turned out to be one of
FIVE defects; see the last two sections.** It is applied to prod. The delete above is kept here as the
recorded remedy for the original incident, not as a standing instruction.

**Nine new `marketing_distributors` (12 -> 21), and they are user-visible.** `SOS_EG-BR` EGD Branch,
`SOS_EG-HOS` EGD Hospital, `SOS_EP-BK` EPDA-BULK, `SOS_EP-PHS` EPDA-Pharmacies, `SOS_IS-T` Ibn Sina
Tender, `SOS_IS-S` Ibn Sina-Sato, `SOS_PS-T` Overseas Tender, `SOS_RM-T` Ramco Tender, `SOS_SF-T`
Sofico Tender — all `active = true`, so they become selectable vendor options in the portal. These
are **exactly the set `scripts/import-pharmacy-code-references.ts` deliberately excluded** via its
`DISTRIBUTOR_MAP`. Whether a rep should be able to pick a Tender/Hospital/Bulk channel as a
pharmacy's distributor is an OWNER decision that has not been taken. Backup of the pre-sync 12:
`marketing_rollback.marketing_distributors_pre_sync_2026_08_19`.

**It fixed none of the 8 `not_found`** — still 8, unchanged. They are absent from the live map too.
See [[marketing-not-found-codes-have-three-root-causes]].

Related: [[marketing-reference-list-is-a-point-in-time-import]] (the data path, and why an export
request was the wrong idea), [[pos-pharmacy-codes-are-zero-padded]],
[[guard-every-prod-write-when-another-session-shares-the-queue]],
[[ps-and-ps-t-carry-the-same-upa-tender-line-twice]] (tender channels double-count elsewhere too).

## OWNER'S RULING on the 9 new vendors — applied to prod 2026-08-19

He kept only the EGD pair. **Do not re-activate the other seven, and do not let a re-run of the sync
quietly restore them** (it creates them by `normalized_name`, so a re-run WILL make them again).
*Resolved in the fix — see the last section: the new function refuses to insert under a vendor whose
`active` is false, which is the only thing standing between a re-run and the merges being undone.*

| Vendor | ruling | rows |
| --- | --- | ---: |
| EGD Branch | **kept, active** | 71 |
| EGD Hospital | kept, then `active=false` (see final ruling) | 68 |
| Ibn Sina Tender, Overseas Tender, Ramco Tender, Sofico Tender | `active=false` | 9 / 27 / 39 / 44 |
| EPDA-BULK | `active=false` | 234 |
| EPDA-Pharmacies | hidden, then **REVERSED** — merged into `epda` | 0 left |
| Ibn Sina-Sato | **merged into `Ibn sina`, then `active=false`** | 0 left |

**The Ibn Sina-Sato merge is the part to understand before repeating it.** «merge ib-s and ib codes
**in this situation only**» — a one-off, NOT a general rule for the other channels. Of its 3,949
codes, **2,834 already existed under `Ibn sina`** and were deleted as redundant; only **1,115** were
genuinely new and were re-pointed onto `DST_IBN_SINA_9DBF268F`. Re-pointing all 3,949 blindly would
have recreated the `ambiguous` bug at 2,834 codes — **always split collide-vs-safe before a merge.**

**Deactivating is not cosmetic — it makes codes unreachable.** The Vendor `<select>` at
`marketing-validation-workspace.tsx:2462` is fed by `service.ts:4577`
(`.eq("active", true)`), and matching is scoped by `distributor_id`, so a rep can only ever match a
code under a vendor still in the dropdown. **1,898 distinct codes now sit behind a hidden vendor**
(1,571 of them EPDA-Pharmacies) and will read `not_found` to a rep. That was the owner's call, made
knowing the number.

**There is NO admin UI for this.** The app has fifteen read paths to `marketing_distributors` and
exactly one write (`reference-importer.ts:429`, an upsert). Toggling `active` is a direct SQL write
only. Backups: `marketing_rollback.vendor_prune_refs_2026_08_19` (5,873 rows, with `from_vendor_code`)
and `marketing_rollback.vendor_prune_distributors_2026_08_19` (all 21).

**End state, verified:** 50,950 reference rows, **0** ambiguous pairs on either column, 14 vendors in
the dropdown, 48,969 codes reachable, all 311 `marketing_pharmacy_distributor_codes` links pointing
at active vendors with `reference_status`/`reference_match_count` unchanged (301/8/2).

**`tender sofico` too — removed on his say-so, same day.** `DST_TENDER_SOFICO_BAB02120` was one of
the ORIGINAL 12, not one of the 9; its 2 rows came from `Phoenix Pharmacy Database.xlsx` (May), it
carried zero pharmacy links, and neither code (`2500001312` المعادى, `6500000617` مدينة نصر) exists
under plain `sofico` — so no merge was possible and those 2 codes are now unreachable. **Every
tender channel is now hidden; the rule is "no tender is a pickable vendor".**

**FINAL end state, prod 2026-08-19:** **13 vendors** in the dropdown — chimipharm · EGD · egd 1002 ·
EGD Branch · EGD Hospital · epda · Ibn sina · mec · POS · ramco · sofico · ساتو فارما جملة ·
ساتو فارما صيدليات. 50,950 reference rows, **0** ambiguous pairs, **48,967** codes reachable,
**1,899** behind a hidden vendor, **0** existing links stranded.

## REVERSAL, same evening — EPDA-Pharmacies was NOT a bulk channel

**Hiding `EPDA-Pharmacies` was a mistake, caused by MY description, and it was reversed within the
hour.** When I listed the nine new vendors I called them "Tender / Hospital / Bulk / Branch
channels" and gave `EPDA-BULK` as the example. That put `EPDA-Pharmacies` in the same bucket by
association. The two names mean **opposite** things.

**The evidence that settles it — company-name markers (`شركة`, `م -`, `للصيادلة`) in the master:**

| Vendor | named codes | look like companies |
| --- | ---: | ---: |
| EPDA-BULK | 58 | **31.0 %** |
| EPDA-Pharmacies | 1,218 | **0.4 %** |

`EPDA-BULK` really is wholesale — «شركة ال هويدى فارما», «الوطنية للصيادلة», «م - بيرفكت فارم» — and
stays hidden. `EPDA-Pharmacies` is the EPDA **retail pharmacy list**: «محمود هندى - المحله الكبرى»,
«اشرف رفاعي - امبابه», «الهداية - دمنهور» — owner name + town, 1,178 named, 34 areas. Hiding it made
**793 shops completely unreachable**, 443 of them named.

**The proportion was the tell, and it generalises:** plain `epda` held only **64** codes while
`EPDA-Pharmacies` held **1,571**, overlapping on just **15**. **When a "channel" vendor dwarfs its
own parent vendor, it is not a side channel — it IS the customer list.** Check that ratio before
hiding any vendor.

Merged into `epda` the same way as Ibn Sina-Sato: 15 redundant deleted, **1,556 re-pointed**;
`epda` 64 -> **1,620** rows. Verified after: **0** ambiguous pairs, 0 rows left under `SOS_EP-PHS`,
sampled shops each resolve to exactly 1 pass-1 match, 0 existing links stranded.

**Codes reachable 48,967 -> 49,716; hidden 1,899 -> 354.** Still hidden and correctly so: EPDA-BULK
(234), the four tenders (119), and `tender sofico` (2).

## FINAL vendor ruling — prod 2026-08-19, 12 vendors visible

**EGD Branch stays, EGD Hospital is hidden.** They were checked with the same two tests and split:

| | EGD Branch | EGD Hospital |
| --- | ---: | ---: |
| Codes | 71 | 68 |
| Named in master | 18 | **1** |
| Name starts «صيدلية» | **17** | 0 |
| Ruling | **active** | `active=false` |

`EGD Branch` is EGD's own state pharmacy chain — «صيدلية الزمالك», «صيدلية طلعت حرب», «صيدلية البنك
المركزى», «صيدلية جامعة الازهر», and the 24-hour «صيدلية إسعاف (24)» outlets across the governorates.
Real dispensing shops a rep can call on. `EGD Hospital` is a hospital channel whose **67 of 68 codes
have no name and no address at all** — a rep matching one could never confirm what it is.

**Neither triggered the dwarfs-its-parent test** (71 and 68 against `EGD`'s 1,977), which is why the
EPDA reversal does not apply to them — the deciding evidence was the CONTENT, not the size. Use both
tests: ratio-to-parent AND what the names actually say.

**Hidden vendors, final (422 codes):** EGD Hospital 68 · EPDA-BULK 234 · Ibn Sina Tender 9 ·
Overseas Tender 27 · Ramco Tender 39 · Sofico Tender 44 · tender sofico 2. `Ibn Sina-Sato` and
`EPDA-Pharmacies` are hidden too but hold 0 rows — both were merged into their parents.

**Visible at that point (12)** — superseded below, `ساتو فارما جملة` was hidden after.

**Verified end state:** 50,935 reference rows, **0** ambiguous pairs on either column, **49,648**
codes reachable, 422 hidden, **0** existing pharmacy links stranded on a hidden vendor, and all 311
`marketing_pharmacy_distributor_codes` rows unchanged (301 matched / 8 not_found / 2 manual_approved).

## The جملة / صيدليات rule — it decided EVERY vendor call, prod 2026-08-19

The Arabic (and English) suffix on a vendor name turned out to be the reliable signal, confirmed
against content every time:

| suffix | means | ruling | examples |
| --- | --- | --- | --- |
| `جملة` / `BULK` / `Tender` / `Hospital` | wholesale, tender, institutional | **hidden** | ساتو فارما جملة, EPDA-BULK, the 4 tenders, EGD Hospital |
| `صيدليات` / `Pharmacies` / `Branch` | retail dispensing shops | **kept** | ساتو فارما صيدليات, EPDA-Pharmacies (merged into `epda`), EGD Branch |

**`ساتو فارما جملة` (`DST_REF_D0E63582`, 28 codes) is EPDA-BULK under another label — all 28 of its
codes are in EPDA-BULK too.** Contents: «الوطنية للصيادلة», «شركة اورينت جروب», «شركة ريونيون
للتجارة», «الجمعية التعاونية لصيادلة12», «الحجاز فارما النسيم قطاعى». Hidden; 18 codes stranded, the
other 10 stay reachable under `epda`.

**`ساتو فارما صيدليات` (`DST_REF_2FEC1A55`, 763 codes) kept.** 723 named retail shops with street
addresses — «نادية رشوان - المرج», «رشا راشد - غبريال», «هدير حشيش - اوسيم» — only 5.9 % carrying any
company marker. It overlaps the EPDA-Pharmacies universe (نادية رشوان is in both). **All 763 are
reachable under another active vendor, so it adds no unique coverage — but that is a reason to KEEP
it, not hide it:** it costs nothing, creates no ambiguity (separate `distributor_id`), and gives a
rep the right label if their shop really does buy from Sato.

**The dropdown at that point — 11** (superseded by the 9 below): chimipharm · EGD · egd 1002 · EGD Branch · epda · Ibn sina ·
mec · POS · ramco · sofico · ساتو فارما صيدليات.

**Verified end state:** **0** ambiguous pairs on either column, **49,630** codes reachable, 422
behind a hidden vendor, **0** of the 311 `marketing_pharmacy_distributor_codes` links stranded.

**Three tests to run before hiding any future vendor, in this order:**
1. **Content** — read the customer names in `source_of_sales_customer_map`. Company markers
   (`شركة`, `م -`, `للصيادلة`, `مؤسس`, `مستشف`) vs a person + town. This is the deciding test.
2. **Ratio to parent** — a "channel" that dwarfs its parent vendor IS the customer list, not a side
   channel (EPDA-Pharmacies 1,571 vs `epda` 64 — the one that was got wrong).
3. **What is stranded** — count codes with no other ACTIVE vendor carrying them, and check
   `marketing_pharmacy_distributor_codes` for existing links before every deactivation.

## THE FIX — APPLIED TO PRODUCTION 2026-08-19, PR #2224

`supabase/migrations/20260819210000_marketing_sales_code_sync_is_additive.sql`, applied to prod
`ozucdzovmcqvepbozvqf` (ledger version `20260819192903` — the MCP stamps its own timestamp, so the
ledger version never matches the filename here; the *name* is what matches). **Verify before you
trust this section:** `select pg_get_function_result(oid) from pg_proc where proname =
'phx_sync_sales_pharmacy_codes_into_marketing'` — old returns **2** columns, new returns **6**.

**Applying it mutated ZERO data rows** — 50,935 references before and after, 0 ambiguous pairs, 301
links intact. It only retyped a column, added a view, replaced the function, and revoked EXECUTE
from `authenticated`.

**The sync is now a genuine no-op on prod, measured 2026-08-19 right after the apply:** 52,614
candidate pairs — *exactly* the `references_synced 52614` the old function reported during the
incident — of which **would-be-inserted = 0**, 46,673 already present, **5,941 held back behind
hidden vendors**. The old function inserted all 52,614 blind; the new one inserts nothing.

**`public.phx_v_sales_pharmacy_code_candidates` is the dry-run tool — use it instead of guessing.**
It is read-only and shows exactly what a sync would add without running anything. Query it with the
same two `not exists` clauses plus `distributor_active` to get the would-insert count before ever
calling the function.

**The guard alone was NOT enough — there were four defects, and three of them are invisible until
you look for them:**

1. **The guard must span the WHOLE table, not `source_file`.** Scoping it to the sync's own rows is
   precisely the bug — the duplicates live under the *spreadsheet* sources. It also guards on
   `compact_pharmacy_code`, protecting PASS 2's "zero-stripping collapses nothing" invariant.
2. **The opening blanket `delete ... where source_file = 'source_of_sales_customer_map'` had to
   go.** `marketing_pharmacy_distributor_codes.reference_id` is an **FK with ON DELETE SET NULL** —
   every validated code matching a Sales-sourced row would silently lose its provenance on the next
   run while `reference_status` stayed `matched`. Zero rows affected TODAY only because the
   Sales-sourced rows are new; making them matchable is the whole point of the sync, so it would
   have bitten on the run after. Replaced by a retirement delete that fires only when the live map
   no longer produces the pair AND nothing points at it.
3. **`source_row` was `id::integer`** on a bigint whose max is already 736,844. **Hashing it is
   unsafe** — `(source_file, source_row)` is UNIQUE, so a collision aborts the sync. Widened to
   bigint.
4. **A re-run would have UNDONE the two vendor merges above.** Measured against prod: it would have
   inserted **5,520 rows** back under the hidden `Ibn Sina-Sato` (3,949) and `EPDA-Pharmacies`
   (1,571) — a merge re-points codes onto a *different* `distributor_id`, which the guard in (1)
   cannot see. The INSERT now requires `distributor_active`; **retirement deliberately ignores it**,
   so the 422 rows deliberately kept behind hidden vendors survive. Held-back rows come back as a
   counter, not silence.

Also: `EXECUTE` was granted to `authenticated` (nothing in `src/` calls it) — now `service_role`
only. And the script pre-flights `pg_get_function_result` and **refuses to run** against a DB still
holding the old function.

**A `not exists` cannot see the rows its own INSERT is adding**, so the candidate set is
de-duplicated against itself with `distinct on` in a new view
`phx_v_sales_pharmacy_code_candidates`. Zero rows today; one import away from mattering.

**Rehearsed on staging** (`cifwmndunmlxjhyjugxa`, which held the exact 45,414-row pre-incident
snapshot): old function → 95,159 rows / **44,213 ambiguous**; new function run 1 → 50,946 / **0**;
runs 2 and 3 → identical, `references_synced: 0`. Regression test
`tests/marketing-sales-code-sync-rerun.test.ts`, wired into `run-tests.ts`, with 13 mutations each
confirmed to fire a named assertion.

Related: [[migration-file-written-is-not-migration-applied]] — this is exactly that shape.

## THE FIFTH DEFECT — retirement would have DELETED the merges. Caught before the first run.

**Migration `20260819220000_sync_retirement_must_not_undo_a_vendor_merge.sql`, applied to prod
2026-08-19 (PR #2227).** Found by checking what the retirement pass would delete BEFORE running the
"safe" sync for the first time — which is the only reason it was never a live incident.

**The asymmetry to remember: a vendor merge has TWO directions, and guarding one does not guard the
other.**

- 20260819210000 stopped the INSERT *recreating* rows under a hidden vendor. ✓
- Nothing stopped the RETIREMENT *deleting* the rows the merge had produced. ✗

A merge re-points the surviving codes onto the **parent's** `distributor_id` (and rewrites
`raw_distributor_name` to match, so a merged row is indistinguishable from a native one). But
`phx_v_sales_pharmacy_code_candidates` derives the vendor from the SALES distributor name, so it can
only ever justify those codes under the hidden **child**. Retirement asked "does the map justify this
pair under THIS vendor?" — and for every merged row the honest answer is no.

**Measured on prod: it would have deleted 2,671 rows** — `epda` **1,556** (the EPDA-Pharmacies merge)
and `Ibn sina` **1,115** (the Ibn Sina-Sato merge). Those are the *exact* re-pointed counts recorded
above. **None was link-protected**, so all 2,671 would have gone on the very first run.

**The rule now:** retire only when the code is absent from the live map **ENTIRELY**, not merely
absent under the vendor the row sits on. Per-vendor rule = 2,671 deleted; per-code rule = **0**. Not
one of the 2,671 was genuinely stale.

**Accepted cost, deliberately:** a code that genuinely moves vendor A → B in the Sales map leaves its
stale row under A. That is a duplicate across *different* `distributor_id`s, which the resolver does
NOT read as ambiguous (matching is scoped by distributor), so it costs one redundant row. It is
reported as `references_retained_linked`, never silently dropped — see
[[never-silent-drop-count-and-flag-instead]].

**STAGING COULD NOT HAVE CAUGHT THIS, and that is the transferable lesson.** The staging rehearsal
was thorough and green; staging simply has no merged vendors. **When prod has had manual data
surgery that staging has not, a green staging rehearsal proves nothing about the shapes that surgery
created — enumerate what the write would touch ON PROD, read-only, before running it.**

## THE SYNC WAS RUN ON PROD — 2026-08-19, twice, and it is a no-op

```
distributors_created 0 · references_synced 0 · references_skipped_existing 46,673
references_retired 0 · references_retained_linked 2,671 · references_held_hidden_vendor 5,941
```

Identical on both runs. Row set byte-identical to the pre-run backup: **0 lost, 0 added**, 0
ambiguous pairs, 0 compact collisions, 301 links intact, 3,589 rows still under the two merged
vendors. Backup: `marketing_rollback.code_refs_pre_sync_2026_08_19b` (50,935 rows).

**`references_retained_linked: 2,671` is the EXPECTED steady state, not a warning.** It is the merged
rows being counted rather than deleted. It will stay 2,671 until the Sales map itself changes.

## RE-CONFIRMED 2026-08-19 (same day, asked again): ALL hidden vendors STAY hidden

Asked directly to "make the hidden vendor codes reachable", the whole hidden set was re-measured and
put back to the owner as one row per vendor with a dropdown. **His answer: «keep them all hidden».**
No database change was made — that answer IS the live state. Do not re-open this.

**The number to quote is 415 unreachable codes, NOT 5,941.** `references_held_hidden_vendor: 5,941`
from the sync is a count of CANDIDATE PAIRS under inactive vendors, and 5,520 of those are the
Ibn Sina-Sato / EPDA-Pharmacies codes that are **already reachable** under the parents they were
merged into. Quoting the sync counter as "unreachable codes" overstates the problem by 14x — that
mistake was made in this session and corrected.

**The genuinely stranded 415, and why each stays hidden** (his own two tests, re-run):

| Vendor | codes | unreachable | evidence |
| --- | ---: | ---: | --- |
| EPDA-BULK | 234 | 208 | 41.4 % company markers |
| EGD Hospital | 68 | 68 | 67 of 68 have NO name at all |
| Sofico Tender | 44 | 44 | hospitals, institutes, clinics |
| Ramco Tender | 39 | 39 | 58.8 % companies — الهيئة العربية للتصنيع |
| ساتو فارما جملة | 28 | 18 | all 28 are EPDA-BULK relabelled |
| Overseas Tender | 27 | 27 | no named codes |
| Ibn Sina Tender | 9 | 9 | no named codes |
| tender sofico | 2 | 2 | zero links, absent from plain `sofico` |

Every one is tender / wholesale / hospital — so the جملة-vs-صيدليات rule and "no tender is a pickable
vendor" both still hold after a full re-test. **The rule is not a one-off from the first pass; it
survived being challenged.**

**Never un-hide `Ibn Sina-Sato` or `EPDA-Pharmacies`.** They hold 0 rows. Un-hiding them unhides
nothing — it just lets the sync insert 5,520 rows back under them and recreates the ambiguity
incident this whole file is about.

The third option that was offered and NOT taken: re-pointing the stranded codes onto their active
parents (reachable without making tenders pickable). Collision counts if it is ever revisited:
EPDA-BULK 208 move / 26 collide; ساتو فارما جملة 18 / 10; every other vendor collides on 0.
Decision sheet: `xlsx/hidden-vendors-decision-2026-08-19.xlsx`.

## THE FINAL DROPDOWN — 9 vendors, prod 2026-08-19

**EGD · EGD Branch · epda · Ibn sina · mec · POS · ramco · sofico · ساتو فارما صيدليات**

Down from 21 after the sync (12 before it). **Codes reachable never dropped below 49,630** — every
vendor removed after EPDA-Pharmacies was a duplicate label or an empty shell, so the pruning cost
nothing.

**Two more hidden at the end, both pathological:**

**`chimipharm` (`DST_CHIMIPHARM_D590ED0B`) — a vendor that could NEVER match.** It is a real sales
distributor (`source_of_sales_distributors.distributor_code = 'CP'`) but has **0 rows in
`source_of_sales_customer_map`** and therefore **0 reference rows** — so every code a rep typed
against it returned `not_found` *by construction*, the B-154 dead end made permanent and unavoidable.
**Re-activate it the moment a Chimipharm sale appears in a monthly upload** (per
[[marketing-reference-list-is-a-point-in-time-import]] the codes arrive with the sales, so this
self-heals). Its one link, the synthetic `ROI-P-CC7FF70B600D` `[not_found]`, is now stranded —
**the only deactivation all evening where the "no existing links" guard was deliberately waived**,
and the write guarded instead on that link still being exactly that code and status.

**`egd 1002` (`DST_EGD_1002_D380502C`) — a duplicate label for EGD Branch.** All **19 of its 19**
codes are in `EGD Branch` (same `60xxx` range, same shops: «صيدلية البنك المركزى - قصر النيل»,
«صيدلية الجهاز المركزى»). It does **not** exist in `source_of_sales_distributors` at all — a
spreadsheet artifact, almost certainly EGD's account number 1002. 0 codes lost, 0 links.

**A vendor with zero reference rows is a TRAP, not an empty list.** Check
`count(reference_rows) = 0` before trusting any vendor in that dropdown — it guarantees `not_found`
for every code, and nothing in the UI says so.

**Verified end state:** **0** ambiguous pairs on either column · **49,630** codes reachable · **9**
vendors visible · **1** link stranded (the synthetic ROI placeholder, by agreement) · 311 links
total, still **301 matched / 8 not_found / 2 manual_approved**, unchanged all evening.

## The completed 9-vendor sweep, and its TWO limits — prod 2026-08-19

Every surviving vendor was measured the same way. All nine are legitimate retail channels; **nothing
further should be pruned.**

| Vendor | codes | named | wholesale markers | unique coverage | live links |
| --- | ---: | ---: | ---: | ---: | ---: |
| POS | 28,702 | 27,656 | 2.4 % | 28,702 | 206 |
| Ibn sina | 15,274 | 12,736 | 1.0 % | 15,273 | 92 |
| EGD | 1,977 | 734 | 4.1 % | 1,972 | 2 |
| epda | 1,620 | 1,182 | 7.3 % | 857 | 4 |
| ramco | 1,115 | 622 | 4.5 % | 1,115 | 3 |
| sofico | 798 | 509 | 3.7 % | 798 | 3 |
| ساتو فارما صيدليات | 763 | 723 | 6.2 % | **0** | 0 |
| mec | 145 | 124 | **0 %** | 144 | 0 |
| EGD Branch | 71 | 18 | 1 code | 66 | 0 |

`mec` is the cleanest — 116 of 124 named codes carry the «ص.» prefix (abbreviation for صيدلية), zero
wholesale markers. `EGD` looked odd at only 3 «صيدلية» prefixes but its names are the unprefixed
person+town pattern («ناجي - السباعية», «ساره سعيد - مدينه نصر»), 4.1 % wholesale.

### LIMIT 1 — hiding the channel vendors did NOT remove hospitals or warehouses from the system

**They live inside the main retail vendors too, and always did.** Ibn sina alone carries «مستشفى
الامومة», «مستشفى الجزيرة الدولى», «مستشفى ابن سينا التخصصى», «مخزن ادوية الملكة», «شركة مخازن
كومباس فارما», «الشركة الوطنية للصيادلة». **788 such codes (656 POS + 132 Ibn sina) remain
reachable — nearly double the 422 that were hidden.** The channel vendors were LABELS, not a clean
split of customer types. Vendor-level pruning cannot exclude institutional customers, and claiming
otherwise would be wrong; excluding them would mean deleting individual reference rows, a different
and far more invasive operation that was NOT done and was not asked for.

### LIMIT 2 — `POS` is the one vendor whose label ≠ its match key

`display_name = 'POS'` but `normalized_name = 'overseas'` (`DST_POS_1478C028`) — the only mismatch
among the nine. **Benign, and in fact load-bearing:** it is why the sync attached the SoS `Overseas`
rows to the existing POS vendor instead of creating a duplicate. But a query filtering
`normalized_name = 'pos'` returns NOTHING. Match on `distributor_code`, never on the display label.
See [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]] for the same class of naming trap.
