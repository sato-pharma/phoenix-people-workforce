---
name: a-marketing-venue-inherits-the-capturers-area-not-its-own-location
description: "marketing_pharmacies/marketing_customers take area_id from the OWNER, so a head-office capture files a real Beheira pharmacy under the nationwide 'Egypt' area — 7 active staff can trigger it"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3bae391f-d43d-4c21-9c4b-070fed06efee
  modified: 2026-08-23T18:01:25.471Z
---

**A marketing venue is filed under the area of whoever captured it, never the area it stands in.**
Both insert sites in `src/lib/marketing-requests/service.ts` — the pharmacy insert (~6046) and the
customer insert (~5859) — set `area_id: owner.areaId ?? null`. Nothing consults the GPS, the
geocode, or the matched distributor code.

For a field rep that is right: their area IS their territory. For **head office it is wrong**, and
silently so.

**The case that exposed it (2026-08-23).** Nahed Hattab (`A-10`, Product Manager) captured pharmacy
هاني ابو العزم and two doctors in Kafr El Dawwar. Her `employees.area_id` is `42` — code `egypt`,
name "Egypt", a nationwide bucket on the Pedia line. All three rows were therefore filed under
"Egypt" while every other active marketing pharmacy in the table sits on the AB/CA/D/GZ/UE
generation whose `areas.code` matches master data. Three independent sources all said Beheira:

- registered distributor code `1506643` → `mapped_area_code = 'AB5'`, and `areas.code = 'AB5'` is
  **Behira 2 (id 1093)** — an exact master match, `master_match_kind = 'exact'`
- matched brick `B114-87` = **كفر الدوار**
- the captured GPS address itself

Corrected in production 2026-08-23: pharmacy `MKT-PHA-20260823-6A547CC0` and customers
`MKT-HCP-20260823-1B2D288E` (احمد محارب) + `MKT-HCP-20260823-9C277CC0` (احمد ابراهيم بحيري),
`area_id 42 → 1093`. Zero marketing rows remain on area 42.

**Fixing the pharmacy alone does nothing.** Territorial screens filter the CUSTOMER's own `area_id`
(`marketing_customers.area_id`), which is stamped independently at insert. Both the venue and every
customer linked to it have to move together or the record stays invisible to the local team.

**Blast radius — this recurs on every head-office capture.** 7 active employees sit on area 42
(3 National Sales Managers, 2 Product Managers, 1 Group Product Manager, 1 Financial Advisor), 13
more on `head_office` (id 80), and others on legacy nationwide areas (Cairo, Giza, Delta (2), Upper
Egypt, Alex-BHR). Any capture by any of them files a physical venue under a non-territorial bucket.

**FIXED IN CODE — PR #2344, live in production `952b6747` 2026-08-23 20:19 Cairo.**
`src/lib/marketing-requests/venue-territory.ts` runs immediately after
`resolveMarketingPharmacyCodes` and, **only when the capturer has no selling territory of their
own**, moves the venue AND the customers minted with it to the area the registered code resolved to.
A capturer already on a real patch is never touched — a mapping table must not reassign a rep's own
customer out from under them, and that direction has its own test. Ordering is load-bearing:
`mapped_area_code` is written by the database resolver (`master_resolved_at` and the pharmacy's
`created_at` land in the same second), so the rule re-stamps *after* resolution and can never read
it during the insert. Like the resolver beside it, it never throws — the catch it sits inside
deletes the whole submission.

"Selling territory" is decided from data, never a hardcoded list: the area codes present in
`source_of_sales_bricks`. Verified exact against production — 39 real territories on one side, the
7 organisational buckets on the other.

**GAP 2 — A REUSED CUSTOMER — CLOSED BY PR #2346 (2026-08-23).** `service.ts:5836` UPDATEs an
existing customer with the new capture columns and is *deliberately* not pushed to `customerIds` —
that list is the rollback set, and unwinding it DELETES a row that predates the request. So
completing an admin-created stub in the field overwrote the GPS and the photo and left `area_id`
exactly as the DESK had stamped it. #2346 gives that set its own gate, asked of the ROW rather than
the capturer: a completed customer moves only when it is on NO area or on an organisational bucket,
each row guarded on its own current area. A completed customer already on a real territory is never
touched, whoever completes it — its area was somebody's choice.

The area now comes from every code the submission **attached**, not only those it minted: a customer
completed at a pharmacy already on file mints no code, so the minted-only read could never fire in
the case the gate exists for. The RESOLVER still gets the minted list alone.

**GAP 1 — A REUSED PHARMACY — CLOSED BY PR #2348 (2026-08-23).** `distributorCodeIds.push(...)`
exists at exactly ONE site (`service.ts:6195`, in the new-pharmacy branch, past the reuse branch's
`continue`), so a submission that attached only venues already on file arrived with an EMPTY code
list and was refused at the first guard — leaving the customer it minted there on the capturer's
area. The refusal was never justified by the data: a pharmacy already on file carries a registered
code that the master resolver has ALREADY placed (`mapped_area_code` is on the row), and #2346
already trusted those same codes to place a customer completed at that venue. The module now takes
one list, `attachedDistributorCodeIds`; the RESOLVER still gets the minted-only list, pinned by a
source assertion on `resolveMarketingPharmacyCodes(supabase, distributorCodeIds)`.

**The two behavioural gates are the part to keep straight, and they are NOT the same question.**
Minted rows are gated on the CAPTURER (a rep on a real patch is never moved); a completed customer
is gated on the ROW (it moves only when stranded). Which CODES are read is a third, separate axis —
always every code attached.

Live count, against the territory authority: **164 active customers and 304 active pharmacies, 0 on
a non-selling area, 0 with no area at all.** Nothing to backfill; both gaps were theoretical.

**`updated_at` ON THESE TABLES IS NOT A TRIGGER — DO NOT READ IT AS AN EDIT DETECTOR.**
`pg_trigger` carries nothing for `marketing_customers` or `marketing_pharmacies`, so only code that
sets the column explicitly moves it. Six of Nahed's eight customers sit on real territories
(Assuit 1/2, Sohag1, Alex East) with `updated_at = created_at`, which reads as "born correct" and
flatly contradicts the code — there is one insert path, it stamps `owner.areaId`, and her
`employees.area_id` has been 42 since 2026-08-10 with no second directory row. They were repaired
later by a hand-run UPDATE that never stamped the column. Audited pharmacy repairs of exactly this
shape sit in `audit_logs` from the same morning ("Moved محمد منديشة from D14 (Gharbia 1) to D15
(Gharbia 2) to follow its POS code"). The customer repairs left no audit row at all.

Related: [[marketing-customers-belong-to-areas-not-people]] ·
[[seeded-marketing-pharmacies-have-no-area-and-are-invisible]] ·
[[sos-bricks-are-the-authority-for-branch-to-area]] ·
[[marketing-validation-report-labels-the-link-not-the-customer]]
