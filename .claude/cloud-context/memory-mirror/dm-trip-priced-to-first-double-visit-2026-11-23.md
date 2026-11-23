---
name: dm-trip-priced-to-first-double-visit-2026-11-23
description: "Owner's rule and four picks (23 Nov 2026): a District Manager's trip is priced from his home to the FIRST double visit he made on it, not to where he captured; Expense Approvals shows both distances"
metadata:
  node_type: memory
  type: project
  originSessionId: c0a87309-b6bc-4f3d-bc23-917253ee831f
  modified: 2026-11-23T10:07:58.328Z
---

On 23 Nov 2026 (about 11:12 Cairo) the owner set a new rule for District Manager trips: "the expense is calculated from his home location to the first location of this double visit". Nothing changes in how he captures: he still captures at the start and at the end of the trip. Expense Approvals shows both distances side by side: home to where he captured, and home to the first double visit the claim is priced on.

His four multiple-choice picks, all the recommended option:

1. **No double visit on the trip** → priced on the distance he captured, and the claim goes to Your call with "No double visit on this trip".
2. **New claims and the claims still waiting.** A decided claim never moves.
3. **The distance shown beside it is home → the capture point** (what the claim was priced on before).
4. **The visits that count:** double and chain visits where he is `manager_hr_id` (the first manager only), saved on a trip day, with a position.

**Why:** a District Manager drives to ride with a rep. His capture point can be anywhere, but the double visit is the work the trip pays for.

**How to apply:**
- Built in `src/lib/outstation/dm-double-visit-distance.ts` (pure) and `-server.ts`. The claim keeps what it was priced on in `outstation_expense_requests.distance_basis` (jsonb, added 23 Nov on staging and production).
- Car fuel (km × 2 × the role's rate) and the no-ticket fare move. The claim moves by exactly that delta, and the allowance never moves. A train, bus or other ticket only records the two distances.
- Held as captured: added stops, typed amounts, no fare to the visit. A hand edit after pricing is never priced over.
- Priced at submit and again every morning (07:02 Cairo departure-photo job), because the rep often saves the visit after the manager filed: 18 of 144 trips since July.
- The real District Manager minimum is 60 km. A first double visit under it is flagged "fail" for the approver, never refused. On 23 Nov this applied to five waiting claims, one of them only 2 km from home.
- Preview on 23 Nov: 51 waiting claims, 25 with money moved, net −463.22 EGP. The one-off run is `scripts/outstation/price-dm-claims-on-double-visit.ts --apply`, after the merge is live.
- Related: [[expense-capture-rules-three-choices-2026-11-23]], [[expense-desk-three-choices-kept-as-built-2026-11-23]].
