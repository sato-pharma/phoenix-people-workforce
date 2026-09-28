---
name: venue-validation-rule-gps-photo-then-code-or-licence
description: "OWNER RULE for validating a venue: GPS + live picture are ALWAYS a must. Leg 3 (EITHER the pharmacy code, if it is in our database, OR the pharmacy licence) is a PHARMACY rule only — a nursery has neither, is validated by location + live photo alone, and its approval is the admin's judgement (resolveVenueIdentityRoute answers 'admin', never 'none'). `nursery` is the venue type for ANY venue with no distributor account, so the owner files a direct-order-only CLINIC as one deliberately — not a mis-filing, and no third venue type is wanted. Enforced on the direct-order desk; NOT enforced on the marketing path."
metadata:
  node_type: memory
  type: project
  originSessionId: 552d0894-e597-451a-b26a-062cfcca1d2f
  modified: 2026-09-26T00:56:05.572Z
---

## The rule, in the owner's own framing (2026-08-26)

1. **GPS location — a must.** Always.
2. **A live picture — a must.** Always.
3. **THEN one of two, never both:** the **pharmacy code** when it is in our database, OR the **pharmacy
   licence** when the code is not in our database / the rep doesn't know it.

**The licence is not obligatory and is not evidence of a visit** — it is the *alternative identity route*
for a venue we cannot resolve by code. A venue with a known, resolving code needs no licence at all.
("Reps aren't uploading licences" is NOT the gap.)

## 🔴 Leg 3 is a PHARMACY rule, and ONLY a pharmacy rule (owner, 2026-08-29)

Both routes of leg 3 are documents of the pharmacy trade, so a venue outside that trade holds NEITHER —
and the answer to "it has no route" is that **it is not judged by routes at all**, never that the route it
cannot take becomes mandatory. Reading leg 3 as universal left the one venue type that could never satisfy
it (nursery) as the only one *required* to, so its request could not be approved and its refusal text told
the admin to attach a document that does not exist — a permanent refusal worded as an instruction.

- **For any venue with no distributor account, legs 1 and 2 are the WHOLE mechanical gate** and identity
  passes to the admin: `resolveVenueIdentityRoute` answers **`"admin"`, not `"none"`.** That is a positive
  answer — a row that later says an approver looked at a pin and a photo and accepted it.
- **The safety net is what makes this safe:** an approved venue is `provisional` on a 90-day probation, and
  a nursery's one available footprint is **a paid direct order** (`findFootprint`). Money still has to
  appear — the gate moved, it did not vanish (cf. [[railway-deploy-applies-no-migrations]] discipline).

## A CLINIC filed as a NURSERY is the owner's OWN filing (2026-08-29)

`nursery` reads like a kind of shop but MEANS **"no distributor account"** — the one question
`venueRequiresDistributorCode` asks. A clinic that buys direct from Phoenix has no pharmacy behind it,
therefore no code, therefore the identical evidence rule (location + live photo, admin's judgement). The
owner confirmed he told the rep to file it this way. Consequences, all "do nothing":

- **A clinic on a `nursery` row is CORRECT** — never sweep it, "fix" it, or raise it as a data-quality
  finding. It reads `Nursery` on the Customer Database register and that is fine.
- 🔴 **Do NOT add a third member to `VENUE_TYPES`.** He was offered one and declined. Every predicate in
  `venue-type.ts` asks the same binary question, so a third answer to a two-answer question is how that
  predicate stops being the single source of truth. Add one only if a venue type ever needs *different
  evidence* — never because a label reads oddly.
- **The reverse mistyping IS still a defect:** a real nursery registered as a **pharmacy** sat wrong.
  A pharmacy row is the one to doubt, not a nursery row.

## 🔴 OWNER RULE 2026-08-29 — confirmed orders make a venue row UNTOUCHABLE

His rule, given instead of a yes: *"Is their orders confirmed or rejected? If rejected, do this. If
confirmed, don't ever touch."*

- **It applies to the ROW, not just the order**, and it **outranks a genuine defect on that row** — e.g. a
  fabricated distributor code that resolves to nothing still STAYS if the row carries approved orders.
- 🔴 **Reversibility is NOT the test — what rides on the row is.** A "reversible, therefore low-risk"
  framing is wrong for a row with large approved business and a collection date out. **Before ANY
  production write to a venue, order, or customer row, count the approved orders against it first and say
  the number out loud.**
- **Zero orders is NOT "rejected"** and he did not rule on it — put a zero-order row to him separately.

**Same-venue duplicate detection:** measure the distance between pins **against the recorded accuracy** (two
pins ~97 m apart when one's accuracy is 100 m overlap = same venue). Different reps with different typed
addresses can capture one venue, so matching on rep or on address string misses it — measure distance vs
accuracy.

## What did NOT change — do not over-apply this

- **A codeless PHARMACY is still refused at `approve`.** If that ever goes null, leg 3 has been repealed
  rather than scoped.
- **The code route is still CLOSED to a nursery**, and a code that RESOLVES for one is the forgery
  signature (invented nursery codes were written *into* `source_of_sales_customer_map` and resolve there
  like real ones). The fix for "a nursery has no code" is that it is not ASKED for one — never that a
  fabricated one starts counting ([[nursery-venues-were-saved-as-pharmacies-with-invented-codes]]).
- **`match` is now REFUSED for a nursery.** Matching inserts a real distributor/customer pair into
  `direct_order_pharmacy_distributor_codes` — a nursery holding a distributor code, the exact shape the
  venue type exists to prevent. Worse than an invented code, because one arriving this way genuinely
  resolves; it just belongs to someone else's business.

## Where it fires — `src/lib/venues/venue-validation-rule.ts` is the single source

Read it before re-deriving any of this.

| Path | Leg 1 GPS | Leg 2 picture | Leg 3 code-or-licence |
| --- | --- | --- | --- |
| Direct-order desk · **pharmacy** | refused at capture | refused at capture | **refused at `approve`** |
| Direct-order desk · **nursery** | refused at capture | refused at capture | **N/A — admin's judgement** |
| Marketing `system_validated` | gates the status | gates the status | **NOT enforced** |

- **Leg 3 is scoped to `approve` alone, and that is load-bearing.** `match` verifies the pair against
  `source_of_sales_customer_map` before accepting it, so matching *is* the code route; `reject` returns
  before the gate, because a venue with neither route must stay rejectable or it becomes undecidable.
- **Marketing was deliberately left out.** Its `system_validated` already computes legs 1 and 2 and gating
  leg 3 server-side is cheap, but the *prompt* is not: the capture screen offers a licence only when a
  venue has NO code, so a pharmacy whose code is `not_found` would be parked on `pending` with the way out
  hidden — the exact harm the owner's 2026-08-12 "flag, don't block" ruling prevents. **Widen the prompt
  first.** When wiring it: only an explicit **`not_found`** counts as "not in our database" — `ambiguous`
  and `pending` are recoverable and must not demand a licence — **and leg 3 must be scoped by venue type
  there too**, or marketing repeats the nursery block from scratch.
- **Already-validated marketing venues sit outside the rule** — statuses are stored, not recomputed, so no
  code change moves them.

Related: [[a-licence-verdict-is-permanent-and-has-no-correction-path]] ·
[[marketing-system-validated-means-no-human-looked]] ·
[[capture-evidence-was-dead-on-arrival-for-doctor-customers]]
