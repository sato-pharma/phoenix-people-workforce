---
name: a-phoenix-crm-validation-is-checked-against-google-maps-never-ireports360
description: "A Phoenix CRM place validation is judged against the account's own Google Maps listing — first confirm it is the SAME account/hospital, then compare the validated point to the Google pin. Owner 2026-10-03: \"forget the ireport data, never compare with it now\" — iReports360 check-ins are NOT evidence for or against a validation."
metadata:
  node_type: memory
  type: feedback
  originSessionId: ba3d8b08-f3b8-44a7-9ad5-9f8fbdb56843
  modified: 2026-10-03T08:55:53.947Z
---

Owner's two-step rule for accepting or rejecting a place validation (2026-10-03, while reviewing Delta (1)'s first day):

1. **Identity first** — confirm the Google Maps listing is the same account/hospital the rep is validating (name, type, town). A customer name can be stale: on 3 Oct "مستشفى المنشاوى العام" was validated 27 m from Google's "مستشفى طنطا العام سبرباي", the new building that news reports call Al-Menshawy's replacement, while Google's Al-Menshawy pin sits 3.6 km away at the old site.
2. **Then compare** the validated point with that Google pin.

**Why:** iReports360 check-ins come from the same rep's own phone, so they are not independent — the owner ruled them out ("forget the ireport data, never compare with it now").

**How to apply:** never cite iReports360 check-in medians as evidence about a Phoenix CRM place, in analysis or in code. Google Maps (Places API with `GOOGLE_MAPS_SERVER_KEY`) is the reference. Related: [[the-validation-accuracy-gate-100m-place-500m-visit]].
