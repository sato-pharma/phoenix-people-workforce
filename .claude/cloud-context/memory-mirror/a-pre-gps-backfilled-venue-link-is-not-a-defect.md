---
name: a-pre-gps-backfilled-venue-link-is-not-a-defect
description: "286 marketing venues from the 2026-06-20 import carry no GPS at all, and the few whose customer sits in another area were INFERRED from real historical marketing requests — read validation_notes before calling one a mismatch, and never move a customer who has five or six correct pharmacies to fix one"
metadata:
  node_type: memory
  type: project
  originSessionId: f151c304-4f1a-4527-86ae-ce961d80f72e
  modified: 2026-09-29T20:21:13.534Z
---

**286 venues created 2026-06-20 have no `captured_latitude` at all** (280 active, 278 carrying a
distributor code, but only **15 linked to a customer**). They are a bulk import, not field captures,
and **none of them has an `extracted_governorate_name`** — so every GPS-based check is blind to them
by construction.

**Of the 15 linked ones, exactly two sit in a different area from their customer, and NEITHER is a
defect.** Both say so themselves in `validation_notes`:

> *"Inferred from pending/rejected historical marketing requests — not GPS field-validated.
> Backfill script 2026-07-02."*

| venue | area | customer | customer's area | the customer's other pharmacies |
| --- | --- | --- | --- | --- |
| «علاء محمد عامر الجديدة» `0001561997` | OT9 | شيرين محمود الوكيل | D12 | **D12×6, OT9×2** |
| «احمد عبدالكريم» `436492` | D24 | هشام حسن | GZ1 | **GZ1×5, D24×1** |

**Why they are right as they stand:**

- The venue's area is confirmed by its **registered code**, which §4.1 makes the authority.
  `0001561997` and `343281` are **two codes from two different distributors** (19 and 17), both
  `exact` in the master, and **both land on OT9**. `436492` is `exact`/`matched` with the master
  name «احمد عبدالكريم» byte-identical to the venue name, on D24.
- The customer's area is confirmed by their five or six other pharmacies.
- The second OT9 link was created by **the owner himself on 2026-09-08**, and its note records that
  it inherited status deliberately: *"nothing was elevated."*

So the straddle is a **real cross-area relationship**, recorded correctly. Moving the customer would
break six correct links to fix one; moving the venue would contradict two independent distributor
masters.

**How to apply:**

- 🔴 **Read `validation_notes` before calling any marketing link a mismatch.** A backfilled row
  states its own provenance, and "inferred from historical marketing requests" is evidence, not a
  gap.
- Two links between the SAME customer and SAME venue are **not a duplicate** — the grain is
  customer + `distributor_code_id`, so a venue with two distributor codes correctly has two.
- 🔴 **The 4 km rule cannot see any of these.** `checkCustomerPharmacyDistance` returns
  `not_comparable` when either side lacks GPS and does NOT refuse — deliberately, since refusing
  would block every legacy row. Never "close that hole": it would reject 286 venues that are fine.
- `system_validated` on one of these means the backfill inherited it from an APPROVED historical
  request, which is weaker than a field check but is not "nobody looked at anything".

Related: [[a-mismatch-query-hides-the-row-that-matches]] ·
[[a-wrong-distributor-code-is-a-typo-not-a-rep-gaming-you]] ·
[[the-marketing-code-resolver-never-re-runs]]
