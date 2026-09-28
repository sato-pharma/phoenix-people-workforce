---
name: marketing-links-were-backfilled-from-a-sheet-not-the-database
description: "Every anomaly in the marketing customer/pharmacy link graph traces to ONE 2026-07-02 backfill of ROI-sheet requests Phoenix never held — the links stood in the request dropdown on ZERO field evidence, and the approved/pending split is NOT reproducible from inside Phoenix (marketing_requests has no row that old). The app-captured path (from 2026-08-02) is consistent. Holds the owner's HOLD ruling (leave them held, release only on capture), the read-the-notes-first rule, and the seed-link traps."
metadata: 
  node_type: memory
  type: project
  originSessionId: da5b316c-c6c1-4593-abd2-1ff2cab200e2
  modified: 2026-09-26T03:17:03.450Z
---

**Every anomaly in the marketing customer/pharmacy graph traces to one backfill on 2026-07-02.** The
app-captured path (from 2026-08-02) is internally consistent. The backfill wrote **303 links** and split them
by a note it stored in `validation_notes`:

- *"Inferred from **approved** historical marketing requests"* → `system_validated`
- *"Inferred from **pending/rejected** historical marketing requests"* → `pending`

🔴 **Those historical requests are NOT in this database.** `marketing_requests` rows are all created
2026-08-02 or later; none predate the backfill or name these pairs. The approvals lived in the external ROI
sheet the `ROI-C-…` / `ROI-P-…` codes came from — so the split is not reproducible from inside Phoenix, and
every backfilled link stood in the rep's request dropdown on **zero field evidence**. (A later hand-run
2026-09-08 backfill of SECOND distributor codes carries NEITHER marker — `INFERRED_HISTORY_MARKER` nor
`DESK_VALIDATION_MARKER` — so code reads it as a rep field capture; that is a trap when auditing.)

## Owner rulings (do NOT re-ask)

- 🔴 **The held set stays held.** 39 backfilled links (later 45, with 6 second-code twins of held pairings)
  were put on `pending` by owner decision 2026-08-21; he was shown all of them in a dropdown workbook and
  answered **"leave them held" — no releases, no retirements.** The release condition is written ON THE
  ROWS — *"Release only once the shop is captured or the pairing is confirmed"* — so the next legitimate
  trigger is field evidence arriving, not another review. **The hold survives capture:** the completion sweep
  (`refreshLinksAfterCustomerCompletion`) skips any link whose notes contain `MARKETING_MANUAL_HOLD_MARKER`
  (`"by owner decision:"`, in `types.ts`), so even a fully photographed pair stays `pending` until a human
  releases it. **Match the marker with `validation_notes ilike '%by owner decision:%'`, never as a prefix** —
  the hold text is APPENDED after the backfill's own sentence.
- 🔴 **Use the distributor's REGISTERED area, not a name match** (owner, 2026-09-17: "use the registered area
  for all 5 pharmacies"). When a pharmacy's area on a ruling sheet was resolved by NAME-matching rather than
  the registered brick, and the two disagree, the registration wins.
- 🔴 **`تعاقد الكهرباء جليم` and `تعاقد شركة الكهرباء` are NOT junk rows** — they are corporate-contract
  customers whose codes resolve to three governorates at once, so the owner assigned each an area by hand; the
  ruling is written on the row (*"NOT a bad record and NOT to be deactivated"*). They are the only two such
  rows, and both stay `customer_type='doctor'` (arguably wrong, but he did not ask for a retype).
- 🔴 **Read `validation_notes` on a marketing row BEFORE calling it anomalous** — the odd-looking rows are
  exactly the ones a previous session already investigated and annotated.

## The stuck-queue diagnosis (measured, still true)

The backfilled `pending` links never moved because every exit was shut, not because a sweep failed:

- **A pending seed link needs evidence on BOTH sides** — `resolveMarketingSystemValidationStatus` requires
  customer AND pharmacy evidence `complete`, and every seed customer is `evidence_status='missing'`, so
  fixing the pharmacy alone changes nothing. **Do not promise a duplicate-pharmacy merge unblocks a link
  without checking `marketing_customers.evidence_status` first.**
- **Releasing these by SQL would FORGE the evidence the check exists to require.** The only routes are field
  capture, or an SFE/Super Admin ruling via `approveCustomerPharmacyLink`.
- The blocking governorate check (holds a link when a capture contradicts the code's region) cannot help
  these rows — they have no capture at all.
- **Field capture was IMPOSSIBLE for `doctor` customers** until the create path was fixed (it could only
  INSERT, so capturing a customer you already owned minted a duplicate; and a first fix was rejected for every
  `doctor` customer, which is essentially the whole cohort). Now Capture Evidence works and re-decides the
  links — see [[capture-evidence-was-dead-on-arrival-for-doctor-customers]] and
  [[marketing-link-status-is-frozen-at-write-time]] (the half that actually empties the queue).

## Traps for auditing and for any owner ruling-sheet

- ⚠️ **`approveCustomerPharmacyLink` writes `system_validated`** — the "no human looked" label — with note
  `Approved by <hr id>`, so today a human ruling is distinguishable from a machine one only by its NOTE.
- 🔴 **Each approve or reject is the owner's own click on `/admin/customer-pharmacy-mapping`** — never SQL,
  never a session, never suggested for him. A "change an area" instruction is NOT an approval of the pairing.
  Any area write on production is a bulk data change — announce it and take the pre-image first (§8).
- **Area names are unique only among ACTIVE areas** — inactive line areas reuse "Alex Center", "Minia 1",
  etc., so resolve a name with `is_active and line_id is null`. A record appearing on several rows with
  different areas is a **question for the owner, never a pick**; duplicate records surface here and are never
  merged on a name (§2.3).
- **Reading a returned owner sheet:** match each row to the SENT copy by its visible non-answer cells (never
  by position — he may sort it, and a filter that stops short of the hidden id columns misaligns them), find
  columns by HEADER, and read the changed areas back to him in chat.
- **Retiring a customer does NOT cascade to its links** — deactivate both together or the orphan link comes
  back `active`/`system_validated` on a dead customer.
- **Two nudge gaps** (offered as a task, not fixed): `linkHasFieldEvidence` (`validation-report.ts`) counts a
  link with neither marker as field evidence, silently removing its customer's "not field-validated" badge and
  daily nudge; and `groupFieldCaptureBacklog` routes to `owner_hr_id ?? manager_hr_id` without checking the
  owner still works here, so some customers are nudged only to a leaver.
- Production has **PITR OFF** ([[production-supabase-has-no-pitr-only-daily-backups]]) — a per-row edit is
  reversible only if it was a pure substring substitution or a guarded update with the pre-image saved; a
  snapshot restore is a blunt last resort, never a per-row undo.

See [[customer-pharmacy-link-grain-is-customer-plus-code]] for the grain trap in this table, and
[[marketing-reference-raw-area-drifts-raw-region-does-not]] for which reference column is safe.
