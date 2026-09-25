---
name: crm-integrity-module
description: "Super-Admin-only /admin/crm-integrity module correlating every ireports360_visits row against its best-matching check-in (exact contact_crm_id first, same-day time proximity second), flagging contact match, save-lag and over-180km/h speed infeasibility. CONFIRMED DEAD END, do not re-investigate: no link exists between contact_crm_id and any Phoenix customer/pharmacy master table, and GPS coverage on that master data is negligible."
metadata: 
  node_type: memory
  type: project
  originSessionId: 7fd28c01-1b85-4e3d-aac4-0dafb7be681f
---

New standalone, Super-Admin-only module at `/admin/crm-integrity` (nav entry under "Field Coaching", `src/lib/crm-integrity/`, `src/components/crm-integrity/`) correlating every `ireports360_visits` row against its best-matching `ireports360_checkins` row (exact `contact_crm_id` match first, nearest same-day time-proximity fallback second — stronger than Visits Report's own `attachNearestCheckins`, which never uses `contact_crm_id`). Flags (no weighted score, per explicit scope decision): 3-state contact match, save-lag (visit saved on a later calendar day than its matched check-in), and speed-feasibility (haversine distance/speed between an agent's consecutive check-ins, >180 km/h = flagged, matching [[keyset-pagination-orderby-id-trap|outstation's own threshold]] for vocabulary only, not shared).

**Why:** User wanted to cross-check CRM visit logs against GPS check-in reality for admin review — "reach a perfection god mode." Investigated first, before building: whether comparing a rep's check-in GPS against a *known customer/pharmacy location* was viable.

**Confirmed dead end — do not re-investigate:** No link exists between the CRM's `contact_crm_id` and any Phoenix customer/pharmacy master-data table. `marketing_customer_contacts.crm_code` exists but is 100% unpopulated and referenced by zero application code. Even if built, GPS coverage on customer master data is negligible in production (1/287 pharmacies, 0/155 customers have coordinates captured). User explicitly decided to drop this idea entirely rather than build unused infrastructure.

**How to apply:** If asked to extend this report with customer-location comparison, first re-verify the dead-end facts above are still true (data collection may have happened since) before assuming it's still blocked. If asked about "why doesn't Visits Report show check-in coordinates" — it deliberately never surfaces raw lat/lon (`attachNearestCheckins` only selects `address`/time), by design, unlike this new module which does show raw coordinates since it's GPS-focused. No migration was needed for this feature — `ireports360_checkins`/`ireports360_crm_identity_resolutions` were already fully migrated on `main` (a false "missing migration" alarm I raised earlier in the same session was wrong — caused by checking the stale primary checkout instead of `origin/main`, see [[stale-checkout-verify-against-origin-main]]).
