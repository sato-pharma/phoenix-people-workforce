---
name: venue-validation-rule-gps-photo-then-code-or-licence
description: "OWNER RULE for validating a venue: GPS + live picture are ALWAYS a must. Leg 3 (EITHER the pharmacy code, if it is in our database, OR the pharmacy licence) is a PHARMACY rule only — AMENDED 2026-08-29: a nursery has neither a distributor code nor a licence, is validated by location + live photo alone, and its approval is the admin's judgement. `nursery` is the venue type for ANY venue with no distributor account, so the owner files a direct-order-only CLINIC as one deliberately — not a mis-filing, and no third venue type is wanted. Enforced on the direct-order desk; NOT enforced on the marketing path."
metadata: 
  node_type: memory
  type: project
  originSessionId: 552d0894-e597-451a-b26a-062cfcca1d2f
  modified: 2026-08-29T14:52:53.799Z
---

**The rule, in the owner's own framing (stated 2026-08-26, correcting mine):**

1. **GPS location — a must.** Always.
2. **A live picture — a must.** Always.
3. **THEN one of two, never both:**
   - the **pharmacy code**, when that code is in our database; or
   - the **pharmacy licence**, when the code is *not* in our database / the rep does not know it.

**The licence is not obligatory and is not evidence of a visit.** It is the *alternative identity
route* for a venue we cannot resolve by code. I had framed "reps are not uploading licences" as the
gap and was corrected: a venue with a known, resolving code needs no licence at all.

## AMENDED 2026-08-29 — LEG 3 IS A PHARMACY RULE, AND ONLY A PHARMACY RULE

His words: *"you must know that pharmacy is the one that have distributor and distributor code.
Nursery does not have distributor code or license. So nursery, they are validated by location and
live photo, and then it's approval depends on the admin."*

**Both routes of leg 3 are documents of the pharmacy trade.** A venue outside that trade holds
NEITHER, so the answer to "it has no route" is that it is **not judged by routes at all** — never
that the route it cannot take becomes mandatory. Reading leg 3 as universal left the one venue type
that could never satisfy it as the only one required to.

**What it cost.** Validation `05c97d18` (عياده دكتور محمد بدوي, filed 16:01 Cairo 2026-08-29 by rep
`b-94`) arrived with a 20 m pin inside the requester's area and a live storefront photo, had no
licence because there is none to have, and **could not be approved at all**. Its direct order
(`3d80f823`) sat `held`, and the refusal text told the admin to attach a document that does not
exist. **A permanent refusal worded as an instruction.**

**So for any venue with no distributor account, legs 1 and 2 are the WHOLE mechanical gate** and
identity passes to the admin, recorded as such: `resolveVenueIdentityRoute` answers `"admin"` for it
rather than `"none"`. That is a positive answer, not a weak one — a row a year later says an approver
looked at a pin and a photograph and accepted it.

**The safety net is unchanged and is what makes this safe:** an approved venue is `provisional` on a
90-day probation, and a nursery's one available footprint is **a paid direct order**
(`findFootprint`). Money still has to appear. See [[railway-deploy-applies-no-migrations]]-style
discipline: the gate moved, it did not vanish.

## A CLINIC IS FILED AS A NURSERY, AND THAT IS THE OWNER'S OWN FILING (2026-08-29)

Asked whether the venue he was trying to approve — عياده دكتور محمد بدوي, "Dr. Mohamed Badawy's
clinic" — was mistyped as a nursery, and whether he wanted a third venue type. His answer:

> *"it is a clinic that only takes direct orders from the company. It doesn't have a pharmacy that
> this pharmacy has a code. So it is the same situation exactly as a nursery. So, uh, I am the one
> who told him to submit it like this."*

**So the vocabulary is not about what the venue IS.** `nursery` reads as a kind of shop and means
**"no distributor account"** — the one question `venueRequiresDistributorCode` asks. A clinic that
buys direct from Phoenix has no pharmacy behind it, therefore no code, therefore the identical
evidence rule: location + live photo, admin's judgement.

**Consequences, all of them "do nothing":**

- A clinic on a `nursery` row is **CORRECT**. Never sweep it, never "fix" it, never raise it as a
  data-quality finding. It will read `Nursery` on the Customer Database register and that is fine.
- **Do not add a third member to `VENUE_TYPES`.** He was offered one and declined by explaining why
  the existing one already fits. Every predicate in `venue-type.ts` asks the same binary question,
  so a third answer to a two-answer question is how that predicate stops being the single source of
  truth. Add one only if a venue type ever needs *different evidence* — never because a label reads
  oddly.
- The reverse mistyping is still real and still a defect: `حضانه النيل` was registered as a
  **pharmacy** on 2026-08-23 and sat wrong for three days. A pharmacy row is the one to doubt, not a
  nursery row.

## 🔴 OWNER RULE 2026-08-29 — CONFIRMED ORDERS MAKE A VENUE ROW UNTOUCHABLE

Asked to approve two repairs on the two `حضانه النيل` rows, he answered with a rule rather than a
yes: *"Is their orders confirmed or rejected? If rejected, do this. If confirmed, don't ever touch."*

**It applies to the ROW, not just the order** — and it outranks a genuine defect sitting on that row.
`DOP-000042` (`6dcef47a`, a nursery) carries a **fabricated distributor code `PS-T` / `0000`**,
written at the same instant as the row by a rep getting past a form that demanded a code from a
nursery. It resolves to **nothing** in `source_of_sales_customer_map`, so it is inert — but the row
also carries **2 approved orders, EGP 220,664.40, collection 2026-09-25**. The code therefore
**STAYS**. Do not offer to strip it again.

This is the safer instinct and it caught a real misjudgement: the flag flip had been filed as
"reversible, therefore low-risk", which is the wrong frame for a row with a quarter of a million EGP
of approved business and a collection date weeks out. **Reversibility is not the test — what rides on
the row is.** Before ANY production write to a venue, order, or customer row, count the approved
orders against it first and say the number out loud.

**Zero orders is not "rejected", and he did not rule on it** — it was put to him separately and
approved separately. The empty twin `صيدليه حضانه النيل` (`e0636c9d`, `PHX-MT-2206F5D400`) was
deactivated 2026-08-29 17:52 Cairo: 0 orders ever, 0 distributor codes, and its *doctor* field held
the venue's own name. Guarded `WHERE` on all six preconditions; rollback is `active = true` on that
id alone. Counts moved 35→34 active venues, 4→3 nurseries, 1→0 nurseries named `صيدلي`, 2→1 active
`النيل` rows in `D12`.

**The two were the SAME venue, and the pins prove it, not the names:** 97.1 m apart, and the older
pin's own accuracy is 100 m, so the circles overlap. Two DIFFERENT reps (`b-10`, `b-154`) captured it
four hours-plus apart with different typed addresses — so a same-venue duplicate here does **not**
look like one rep repeating himself, and matching on rep or on address string would have missed it.
Measure the distance against the recorded accuracy.

## What did NOT change — do not over-apply this

- **A codeless PHARMACY is still refused at `approve`.** If that ever goes null, leg 3 has been
  repealed rather than scoped.
- **The code route is still closed to a nursery**, and a code that RESOLVES for one is still the
  forgery signature. Two of the three invented nursery codes were written *into*
  `source_of_sales_customer_map` and resolve there exactly like real ones. The fix for "a nursery has
  no code" is that it is not ASKED for one — never that a fabricated one starts counting. See
  [[nursery-venues-were-saved-as-pharmacies-with-invented-codes]].
- **`match` is now REFUSED for a nursery** (new 2026-08-29, and it was an open hole before). Matching
  inserts a real distributor/customer pair into `direct_order_pharmacy_distributor_codes` — a nursery
  holding a distributor code, the exact shape the venue type exists to prevent. Worse than the three
  invented ones, because a code arriving this way genuinely resolves; it just belongs to somebody
  else's business. Registration already refused to write one; the desk could still attach one with a
  click.

**Where it now fires.** `src/lib/venues/venue-validation-rule.ts` is the single source — read it
before re-deriving any of this.

| Path | Leg 1 GPS | Leg 2 picture | Leg 3 code-or-licence |
| --- | --- | --- | --- |
| Direct-order desk · **pharmacy** | **refused at capture** (#2434) | refused at capture | **refused at `approve`** (#2434) |
| Direct-order desk · **nursery** | refused at capture | refused at capture | **N/A — admin's judgement** (2026-08-29) |
| Marketing `system_validated` | gates the status | gates the status | **NOT enforced** |

**Leg 3 is scoped to `approve` alone, and that is load-bearing.** `match` verifies the pair against
`source_of_sales_customer_map` before accepting it, so matching *is* the code route; `reject` returns
before the gate, because a venue with neither route must stay rejectable or it becomes undecidable.

**Why marketing was left out of #2434.** Its `system_validated` already computes legs 1 and 2, and
gating leg 3 server-side is cheap. The *prompt* is not: the capture screen offers a licence only when
a venue has NO code, so a pharmacy whose code is `not_found` would be parked on `pending` with the
way out hidden — the exact harm the owner's 2026-08-12 "flag, don't block" ruling was made to
prevent. Widen the prompt first. When wiring it, **only an explicit `not_found` counts as "not in our
database"** — `ambiguous` and `pending` are recoverable and must not demand a licence. **And leg 3
must be scoped by venue type there too**, or marketing repeats the nursery block from scratch.

**Four already-validated marketing venues sit outside the rule** (3 pharmacies + 1 nursery, none with
a licence, none with a code in the database). Statuses are stored, not recomputed, so no code change
moves them.

Related: [[a-licence-verdict-is-permanent-and-has-no-correction-path]] ·
[[marketing-system-validated-means-no-human-looked]] ·
[[capture-evidence-was-dead-on-arrival-for-doctor-customers]]
