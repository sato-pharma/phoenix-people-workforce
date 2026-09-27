---
name: sales-to-marketing-sync-creates-ambiguous-duplicates
description: "phx_sync_sales_pharmacy_codes_into_marketing() blind-inserted codes the spreadsheet imports already held under the same distributor, so 2 exact matches made the capture gate read 'ambiguous' instead of 'matched'. FIXED on prod 2026-08-19 (FIVE defects, additive + merge-safe; verify old=2 cols / new=6 with pg_get_function_result). Keep for the root-cause mechanism, the owner's جملة-vs-صيدليات vendor ruling + the three tests before hiding any vendor, and the reusable lessons (whole-table guard, the two-directional merge trap, staging can't catch a prod-only data-surgery defect, the zero-reference-row trap, POS label ≠ match key)."
metadata:
  node_type: memory
  type: project
  originSessionId: e57e90b1-6df8-4f5f-b57e-e8bd26ebf3a5
  modified: 2026-09-26T02:55:42.447Z
---

**`public.phx_sync_sales_pharmacy_codes_into_marketing()` had a live defect — FIXED ON PRODUCTION
2026-08-19. This is history and reasoning, not a live hazard.** Verify the fix is in place before relying
on it: `select pg_get_function_result(oid) from pg_proc where proname =
'phx_sync_sales_pharmacy_codes_into_marketing'` — the old function returns **2** columns, the new one **6**.
The old `scripts/sync-…​.ts` header ("re-run as Sales imports more distributors") was the trap and is gone.

## The root-cause mechanism (the reusable trap)

The function attaches synced SoS rows to an existing `marketing_distributors` row whenever `normalized_name`
matches, so Sales rows land on the **same `distributor_id`** as the spreadsheet rows. Both sources store the
code in the **same zero-padded form** ([[pos-pharmacy-codes-are-zero-padded]]), so the duplicate lands on
`normalized_pharmacy_code` — the exact column PASS 1 of `resolvePharmacyCodeReference` matches on. And
`buildPharmacyCodeReferenceResult` ([service.ts](src/lib/marketing-requests/service.ts)) reads
`matchCount > 1 ? "ambiguous"`. Pass 2 never rescues it, because pass 2 only runs when pass 1 found ZERO.
The code comment had called this shot in advance: "no two distinct codes inside one distributor share a
zero-stripped key. Should an import ever create one, this returns 'ambiguous' rather than guessing." The
sync WAS exactly that import — run once, it instantly put tens of thousands of exact-match codes into
`ambiguous`, repaired by deleting only the synced rows a pre-existing row already covered (match on
`(distributor_id, normalized_pharmacy_code)`, `source_file = 'source_of_sales_customer_map'`). The net gain
was still worth having: live-map codes invisible to the gate went to 0.

## The owner's vendor ruling — the جملة / صيدليات rule

The sync created nine new `marketing_distributors`, all `active = true` and therefore selectable in the
portal — exactly the Tender/Hospital/Bulk channels `scripts/import-pharmacy-code-references.ts` deliberately
excluded. Whether a rep may pick such a channel as a pharmacy's distributor was an OWNER decision, and he
made it: **the Arabic/English suffix on a vendor name is the reliable signal.**

| suffix | means | ruling |
| --- | --- | --- |
| `جملة` / `BULK` / `Tender` / `Hospital` | wholesale, tender, institutional | **hidden** |
| `صيدليات` / `Pharmacies` / `Branch` | retail dispensing shops | **kept** |

**"No tender is a pickable vendor"** held after a full re-test. The final dropdown is **9 vendors**: EGD ·
EGD Branch · epda · Ibn sina · mec · POS · ramco · sofico · ساتو فارما صيدليات. `EGD Branch` stayed (its
codes are EGD's own state pharmacy chain — «صيدلية …» outlets); `EGD Hospital` was hidden (67 of 68 codes
have no name at all). `EPDA-Pharmacies` and `Ibn Sina-Sato` were MERGED into their parents (`epda` / `Ibn
sina`) and then hidden holding 0 rows — **never un-hide them; un-hiding unhides nothing and just lets the
sync insert the merged codes back and recreate the ambiguity incident.** Owner re-confirmed the same day,
asked directly to make hidden codes reachable: «keep them all hidden». Do not re-open. Backups of the pre-sync
state live under the `marketing_rollback` schema.

**Three tests before hiding any future vendor, in order:**
1. **CONTENT (the deciding test)** — read the customer names in `source_of_sales_customer_map`: company
   markers (`شركة`, `م -`, `للصيادلة`, `مؤسس`, `مستشف`) vs a person + town.
2. **RATIO TO PARENT** — a "channel" that DWARFS its parent vendor IS the customer list, not a side channel.
   This is the one that was got wrong: `EPDA-Pharmacies` (1,571 codes) was hidden as a "bulk channel" by
   association with `EPDA-BULK`, stranding hundreds of real shops, though it dwarfed plain `epda` (64) — the
   opposite names mean opposite things. Reversed within the hour.
3. **WHAT IS STRANDED** — count codes with no OTHER active vendor carrying them, and check
   `marketing_pharmacy_distributor_codes` for existing links before every deactivation.

Deactivating is not cosmetic: the Vendor `<select>` is fed with `.eq("active", true)` and matching is scoped
by `distributor_id`, so a code under a hidden vendor reads `not_found` to a rep. There is **NO admin UI** for
this — toggling `active` is a direct SQL write only.

## The five defects, and the reusable engineering lessons

The fix (`…marketing_sales_code_sync_is_additive.sql` + `…sync_retirement_must_not_undo_a_vendor_merge.sql`,
both applied to prod; the ledger version never matches the filename — [[migration-file-written-is-not-migration-applied]])
made the sync additive and merge-safe. It was FIVE defects, not one:

1. **The guard must span the WHOLE table, not `source_file`.** Scoping a de-dup guard to the sync's own rows
   is precisely the bug — the duplicates live under the *spreadsheet* sources. Guard on both
   `normalized_pharmacy_code` and `compact_pharmacy_code` (protecting pass 2's zero-stripping invariant).
2. **A blanket `delete … where source_file = 'source_of_sales_customer_map'` is unsafe.**
   `marketing_pharmacy_distributor_codes.reference_id` is an FK with **ON DELETE SET NULL** — every validated
   code matching a Sales-sourced row would silently lose its provenance while `reference_status` stayed
   `matched`. Replaced by a retirement delete that fires only when the live map no longer produces the pair
   AND nothing points at it.
3. **`source_row = id::integer`** on a bigint already near overflow — a `(source_file, source_row)` UNIQUE
   collision aborts the sync. Widened to bigint.
4 & 5. 🔴 **A vendor MERGE has TWO directions, and guarding one does not guard the other.** The INSERT guard
   stopped rows being *recreated* under a hidden vendor (now requires `distributor_active`). But nothing
   stopped RETIREMENT from *deleting* the rows a merge had produced — a merge re-points codes onto the
   PARENT's `distributor_id`, while the candidate view derives the vendor from the Sales name and can only
   justify them under the hidden CHILD, so retirement's "does the map justify this pair under THIS vendor?"
   answers no for every merged row. Measured on prod: it would have deleted 2,671 correctly-merged rows on
   the first "safe" run. **Rule: retire only when a code is absent from the live map ENTIRELY, not merely
   absent under the vendor its row sits on.** The residual (`references_retained_linked`) is counted, never
   silently dropped ([[never-silent-drop-count-and-flag-instead]]).

Also: `EXECUTE` was over-granted to `authenticated` (nothing in `src/` calls it) → `service_role` only; and
a `not exists` cannot see the rows its own INSERT is adding, so the candidate set is de-duplicated against
itself with `distinct on` in the read-only view **`phx_v_sales_pharmacy_code_candidates` — the dry-run tool;
query it instead of guessing what a sync would add.** Pinned by a wired regression test.

🔴 **STAGING COULD NOT HAVE CAUGHT the two-directional merge defect — the transferable lesson.** The staging
rehearsal was thorough and green, but staging has no merged vendors. **When prod has had manual data surgery
staging has not, a green staging rehearsal proves nothing about the shapes that surgery created — enumerate
read-only what the write would touch ON PROD before running it.** (Found exactly that way, which is the only
reason it was never a live incident.) [[guard-every-prod-write-when-another-session-shares-the-queue]]

## Two vendor traps that survive the fix

- 🔴 **A vendor with ZERO reference rows is a TRAP, not an empty list** — it guarantees `not_found` for every
  code and nothing in the UI says so. `chimipharm` is a real sales distributor (`CP`) with 0 rows in
  `source_of_sales_customer_map`, so every code typed against it fails by construction; it was hidden and
  **re-activates the moment a Chimipharm sale appears in a monthly upload** — the codes arrive with the sales
  ([[marketing-reference-list-is-a-point-in-time-import]]), so it self-heals. Check `count(reference_rows) =
  0` before trusting any vendor in the dropdown.
- **`POS` is the one vendor whose label ≠ its match key** — `display_name = 'POS'` but `normalized_name =
  'overseas'`. Benign and load-bearing (it is why the sync attached the SoS Overseas rows to POS instead of
  making a duplicate), but a query filtering `normalized_name = 'pos'` returns NOTHING. **Match on
  `distributor_code`, never on the display label** — same class as
  [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]].

**Vendor-level pruning CANNOT exclude institutional customers** — hospitals and warehouses («مستشفى …»,
«مخزن …», «شركة …») live inside the main retail vendors (POS, Ibn sina) too and always did; the channel
vendors were LABELS, not a clean split of customer types. Excluding institutions would mean deleting
individual reference rows, which was not done and not asked for.

The sync fixed none of the 8 `not_found` codes (absent from the live map too) —
[[marketing-not-found-codes-have-three-root-causes]]. Tender channels double-count elsewhere too —
[[ps-and-ps-t-carry-the-same-upa-tender-line-twice]].
