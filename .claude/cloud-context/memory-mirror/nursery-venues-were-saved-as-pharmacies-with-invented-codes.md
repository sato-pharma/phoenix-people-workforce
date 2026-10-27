---
name: nursery-venues-were-saved-as-pharmacies-with-invented-codes
description: "Both marketing link tables demanded a distributor_code_id, so the only way to save a codeless nursery was to make a code up — four production venues did."
metadata: 
  node_type: memory
  type: project
  originSessionId: b974beb4-54ef-40e3-a9b5-e4abda597572
  modified: 2026-08-26T19:14:10.386Z
---

**RESOLVED 2026-08-23** — [PR #2320](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2320),
squash `4ebbf45cf17c`, serving in production (confirmed via `/api/healthz` `revision`). The codes
below are now retired; keep this file for WHY the shape existed and how it was unwound.

**BUT THE SWEEP DOES NOT HOLD — it was a one-time correction, not a gate (2026-08-26).** `venue_type`
DEFAULTS TO `pharmacy` and nothing ever asks, so every nursery still arrives typed as a pharmacy and
has to be caught by hand afterwards. `حضانه النيل` (`direct_order_pharmacies` `DOP-000042`) was
approved at **15:31 on 2026-08-23 — the same morning the sweep ran**, landed behind it, and sat
`venue_type = 'pharmacy'` for three days until the owner spotted it. Converted on production
2026-08-26 22:13 Cairo, one guarded single-row UPDATE; it had invented no distributor code, so unlike
the 08-23 batch there was nothing to detach. **Before believing this file's "resolved", re-run the
census** — `display_name`/`pharmacy_name LIKE '%حضان%'` across `marketing_pharmacies` AND
`direct_order_pharmacies`, and read `venue_type` (11 rows, all `nursery`, as of 2026-08-26 22:13).
Note `مستشفي زمزم` is a HOSPITAL sitting as `pharmacy` and cannot be fixed the same way: the schema
has only `pharmacy` and `nursery`.

`marketing_customer_pharmacies.distributor_code_id` and
`marketing_request_pharmacies.distributor_code_id` were both `NOT NULL` until 2026-08-23, so a
nursery — which has no distributor account and never will — could not be linked at all. Reps
invented codes to get past the form. Verified live on `ozucdzovmcqvepbozvqf` 2026-08-23:

| Venue | Code | Reference status |
| --- | --- | --- |
| حضانة زمزم | `0001511111` | `not_found` |
| حضانه نور المصطفي | `0001000000` | **`matched`** |
| صيدليه حضانه النيل (×2 — duplicate venue) | `0000` | `not_found` |

`0001000000` reads **matched** because the reference import itself holds a filler row (distributor
`overseas`, no address/region/area). So it is not shadowing a real customer — but
`reference_status = matched` proves nothing here. Two of these codes were also written into
`source_of_sales_customer_map`, where a fabricated code resolves `exact` forever;
**the owner decided to leave those master rows and retire only the codes on the venues.**

**What was actually done on production 2026-08-23**, one atomic statement, counts 4/6/5/2:
4 marketing venues and 6 Direct Orders venues set to `venue_type = 'nursery'`; the 5 customer links
detached (`distributor_code_id = null`); the 2 still-active invented code rows deactivated. The code
rows were **deactivated, never deleted** — `marketing_customer_pharmacies.distributor_code_id` is
`ON DELETE CASCADE`, so deleting them would have silently taken the customer links with it. After:
339 customer links (unchanged), 5 codeless, 0 still pointing at an invented code, 4 code rows still
present as history with `active = false`, both `source_of_sales_customer_map` rows untouched.

**The `صيدليه حضانه النيل` "duplicate" was already merged in substance** (checked 2026-08-23).
The rep captured it at 07:56, the evidence photo did not attach, and they recaptured at 08:04 — so
customer, venue, code AND link were all doubled, and the entire first attempt is `active = false` at
every one of those four levels. Nothing live pointed at it. Both dead rows are now stamped in
`validation_notes` with the id they merged into, because nothing else recorded it and the pair
invites re-investigation on sight. Do NOT move the loser's code row onto the keeper:
`marketing_pharmacy_distributor_codes_unique (pharmacy_id, distributor_id, normalized_pharmacy_code)`
makes that a collision — both were distributor 14 / `0000`.

**Marketing had no merge model at all** — the real gap this exposed. `direct_order_pharmacies`
has `merged_into_pharmacy_id` / `merged_at` / `merged_by_hr_id` (used properly on 2026-08-13 to fold
four duplicate `حضانة زمزم` rows into `80b53100-…`); `marketing_pharmacies` had no equivalent, so a
marketing merge could only be expressed as deactivation plus prose.
**Closed by [PR #2323](https://github.com/it-gawish-hr/phoenix-people-workforce/pull/2323), squash
`1c21ade9`, merged 2026-08-23 07:57Z** — all four required checks green.
`mergeMarketingVenue(access, {loserId, survivorId, reason})` moves all four child tables, deactivates
the loser, stamps the trail and writes a required audit row (`entityType: "marketing_pharmacy"`).
Its migration `20260823080000_marketing_venue_merge.sql` was **applied to production
(`ozucdzovmcqvepbozvqf`) 2026-08-23 08:0x Z** and verified against `information_schema`/`pg_constraint`,
not the ledger: 3 columns, FK `on_delete=SET NULL` (never CASCADE), the not-self CHECK, the partial
index, 313 venues unchanged, exactly 1 row marked merged. The `صيدليه حضانه النيل` backfill fired —
`11d655a9-…` → `dfe8d718-…`, `merged_by_hr_id` NULL because no person made that call in the app.
**Reachable from the app since #2357 (merged 2026-08-23, prod `aebc0a43`)** — was server-side only
for one day. `POST/GET /api/marketing-requests/venue-merge` + a "Merge duplicate venues" panel on
the Customer Database screen (Super Admin / SFE Manager, the exact pair `assertMarketingControlAccess`
admits, so the page needs no second gate). The picker reads `marketing_pharmacies` DIRECTLY, not the
Customer Database rows — those are customer LINKS, so an unlinked duplicate would be missing from the
one list that exists to retire it; inactive venues are IN for the same reason (deactivating is how the
module hides a duplicate today, so those rows ARE the backlog). Probe it with **GET** and read the body,
not the code: an unauthenticated GET returns 403 `"only SFE Manager and Super Admin can manage
marketing controls"` — that message proves the service was reached. A garbage sibling path returns
**500, not 404** (it falls into the `[id]` dynamic route), so 404 is NOT the absence signal here.

Still open: `ادفايس` carries `0001500000`, which fits the invented-code pattern but is not a nursery.

Direct Orders never forced this — a codeless pharmacy has been admissible there since 2026-08-04,
and none of its six nursery rows carries a code. Marketing is where they landed.

**Why:** a fabricated code is worse than a blank one. It looks trustworthy to every later reader,
it can match a filler row and read as validated, and it puts spend on a venue whose ROI can never
be measured while making that venue look measurable.

**How to apply:** the fix is `venue_type` (`pharmacy` | `nursery`) plus one predicate,
`venueRequiresDistributorCode` in `src/lib/venues/venue-type.ts` — never re-derive it inline.
`venueCodeSlots` in the marketing service is what still writes the link row for a codeless venue;
without it the venue saves and then does not exist. Related:
[[a-narrowed-select-disarms-every-gate-downstream-of-it]], [[never-silent-drop-count-and-flag-instead]].
