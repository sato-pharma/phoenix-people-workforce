---
name: marketing-venue-evidence-was-writable-only-at-insert
description: "A marketing venue's GPS and live photo could only ever be written by the INSERT that created it — no path completed an existing shop, so a venue born without proof stranded every customer on it for ever. Fixed by PR #2352."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bae391f-d43d-4c21-9c4b-070fed06efee
  modified: 2026-08-23T19:07:38.752Z
---

**A venue's evidence was WRITE-ONCE, and nothing in the product could ever add it later.**
`marketing_pharmacies.captured_latitude` / `evidence_photo_name` / `evidence_status` were written
by exactly one statement: the capture INSERT in `submitMarketingValidation`. Every other write to
that table touches something else — the merge sets `active: false`, `roi-sheet-writer` upserts
name columns only, the territory rule and area consolidation move `area_id`. The reuse branch
updates the LINK row and `continue`s; it never touched the venue.

So a shop first recorded without proof stayed `evidence_status = 'pending'` for the rest of its
life, however many reps stood in front of it — and since a link's status is frozen from the
evidence that existed when the link was written, **every customer attached to it stayed on "Not
Usable Yet" with no route out for anybody.**

**Do not confuse this with the CUSTOMER path, which has always been completable**
(`service.ts` reused-customer `.update({...capturedColumns})`, guarded `.neq("evidence_status",
"complete")`). Customer completable, venue not — that asymmetry is what made the venue case
invisible for so long. See [[a-marketing-venue-inherits-the-capturers-area-not-its-own-location]].

**FIXED — PR #2352 (2026-08-23).** The My Pharmacies entry may carry a capture beside its id.
Optional always; offered only for a venue whose stored evidence is short; never in desk mode (a map
pin is not field proof). Written only when the new capture is COMPLETE — a venue row is shared by
the whole area, so a partial-for-partial swap improves nothing and this way the write can never be
a downgrade. Identity still refused, and so is the VERDICT (`validation_status`,
`validated_by_hr_id`, `validated_at`, `validation_notes` omitted) — those record a human's decision
about the shop, including a Super Admin's desk validation. `refreshLinksAfterPharmacyCompletion` is
the half that matters: without it the shop goes green and the doctors stuck on it do not move.

**OWNERSHIP IS NOT THE LEVER — AREA IS. Do not do ownership backfills.** Since the owner's
2026-08-19 ruling, both `canSeeMarketingCustomer` and `canReuseMarketingPharmacy` pass on
`row.area_id === viewerAreaId` alone; `owner_hr_id` stays only as the audit record of who captured
it. The code comment says so outright: *"nothing is re-stamped when somebody leaves"*, and manual
ownership backfill is *"exactly the busywork this rule abolishes"*. A request to "reassign these
venues to the local reps" therefore changes **nothing** operationally — they can already see and
attach them. Say so instead of writing.

**The production case (2026-08-23).** Three venues, all `owner_hr_id = A-10` (Nahed Hattab, Product
Manager, head office), **none with a single non-desk link**: مستشفى فيكتوريا (Alex East, 2 doctors),
نشأت زكري and الشعب (both Assuit 2, 1 each). Four desk-validated doctors between them, coordinate
but no photo. The doctors cannot be re-captured — the owner's words: *"they go home"* — so the venue
was the only capturable thing, and it was the one thing no code path could write. The areas do have
active Anti Infective reps (all three venues are `line_id = 1`): AI-0002 Ahmed Nabil in Alex East,
B-13 Rana Adel in Assuit 2 — **not** the CNS reps an area-only lookup suggests first.

**A fourth desk-validated customer needed nothing:** وليد كمال (B-116) — both his venues were
completed in the field on 08-18, two days AFTER the desk validation. `isDeskValidated` is a pure
string test on the LINK's note (`readiness.ts:154`) and never looked at the venue, so he wore the
"not field-validated" badge although his evidence is real: the badge could not tell "unprovable"
from "already proven by the venue". **FIXED — PR #2354 (2026-08-23), merged `3cf00925` and live in
production.** `customerFieldEvidenceGap` now reads the two live evidence columns as well as the note,
and EITHER half being `complete` clears it. See
[[marketing-badge-read-a-frozen-note-not-the-live-evidence]] for why either half and not both, and
[[marketing-system-validated-means-no-human-looked]].

Related: [[marketing-customers-belong-to-areas-not-people]] ·
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]] ·
[[marketing-validation-report-labels-the-link-not-the-customer]] ·
[[optional-field-written-unconditionally-is-a-silent-erase]]
