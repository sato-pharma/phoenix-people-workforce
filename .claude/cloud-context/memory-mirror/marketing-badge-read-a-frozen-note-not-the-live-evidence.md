---
name: marketing-badge-read-a-frozen-note-not-the-live-evidence
description: "The marketing \"not GPS field-validated\" badge was decided from the LINK's validation_notes — a sentence written once at insert and never rewritten — so evidence arriving later was invisible and reps who made the trip were called liars. Fixed by PR #2354: EITHER half complete clears it."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bae391f-d43d-4c21-9c4b-070fed06efee
  modified: 2026-08-23T19:53:12.949Z
---

**A `validation_notes` sentence is a claim about the PAST. The badge was reading it as a claim
about the present.** `isDeskValidated` / `isInferredFromHistory` (`readiness.ts`) are pure substring
tests on the link's note, written by the statement that creates the link and **never rewritten by
anything**. `customerFieldEvidenceGap` was decided from those two flags alone.

But evidence arrives AFTER that sentence. A customer has always been completable on a later visit;
since [[marketing-venue-evidence-was-writable-only-at-insert]] (#2352) so is a venue. So the badge
could not tell **"nobody has ever been here"** from **"somebody has been here since"**, and went on
telling reps who made the trip that nobody ever had — the lie the function's own comment already
names as the worse of the two it exists to prevent.

**FIXED — PR #2354 (2026-08-23).** `FieldEvidenceGapInput` now carries `customerEvidenceStatus` and
`pharmacyEvidenceStatus`; `fieldEvidenceGapInput(row)` is the one supported way to narrow a report
row (a screen hand-assembling the input is how the notes-only reading gets back in — source-locked
in the test). Nothing new is fetched: both loaders already `select("*")` and both mappers already
default `evidence_status` to `missing`.

**EITHER half clears it, and `complete` is the bar — do not "fix" this to both halves.** Two
reasons. (1) The badge warns that NO field evidence exists, so what cancels it is *some* evidence.
The module's stricter both-halves rule (`resolveMarketingSystemValidationStatus`, and the "Waiting
for a complete live photo and location on both the customer and the pharmacy" note) decides whether
a link may be **PROMOTED** — a different question. Borrowing it here makes the function a **no-op**:
every marked link in prod is short on one half or the other. (2) The customer half often cannot be
redone — a doctor is not at his pharmacy when the rep calls (**"they go home"**, the owner's own
reason for #2352). `pending` never counts: a coordinate with no live photo IS the desk-validation
shape.

**Production effect, measured LIVE after the deploy (`revision 3cf00925`).** 163 customers on the
report, 316 active links, 294 of them marked. **Badged before 145 → after 139: exactly SIX customers
stop wearing it**, holding 21 active links between them — وليد كمال (MKT-HCP-20260816-A5F808BC, the
desk case that prompted this, 4 links / 4 complete venues), هشام حسن, شيرين محمود الوكيل,
محمد رمضان عبدالحميد, محي خلف عمران, مستشفي تبارك المريوطيه.

**Count it at the CUSTOMER level with `active = true`, or you will overstate it.** A per-link
grouping first gave "15 links / 8 customers", quoted in the PR body and corrected in a comment on
it: raw link groups ignore the report's own `active` filter AND the every-never-some rule, so a
customer that also holds one note-clean link gets counted as "cleared" when it was never badged.

**All six clear on the VENUE half — the customer half clears NOBODY today.** The only customer whose
own row is `complete` behind marked links (حسام البصراتي, ROI-C-CF7662DC8FAF, 5 inferred links) also
carries a 2026-08-21 owner-merge link whose note is clean, so it was already unbadged. Keep that
half anyway: it fires the moment a rep completes a customer sitting on a marked link, which the
reused-customer path does routinely.

**The badge gates NOTHING** — it qualifies a status pill and feeds no filter, permission or write.
`isNotFieldValidated` (readiness.ts) is exported but has **no `src/` consumer at all**, only a test.

Related: [[a-narrowed-select-disarms-every-gate-downstream-of-it]] ·
[[marketing-system-validated-means-no-human-looked]] ·
[[marketing-customers-belong-to-areas-not-people]] ·
[[optional-field-written-unconditionally-is-a-silent-erase]]
