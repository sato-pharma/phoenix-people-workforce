---
name: google-maps-legacy-places-disabled
description: "Prod Google Maps key has the LEGACY Places API disabled; only Places API (New), Routes API, and Geocoding API work. Use v1 endpoints."
metadata: 
  node_type: memory
  type: reference
  originSessionId: ff68f532-902a-41d4-9777-f64bfc890cdc
---

The production `GOOGLE_MAPS_SERVER_KEY` (project `ozucdzovmcqvepbozvqf`, same key in `.env.local`) has the **legacy Google Places API DISABLED**. Calling `maps.googleapis.com/maps/api/place/autocomplete/json` or `.../place/details/json` returns `REQUEST_DENIED` ("calling a legacy API, which is not enabled for your project").

Gotcha: Google returns **HTTP 200** on `REQUEST_DENIED` (error is in the JSON `status`/`error_message`, not the HTTP code). Routes that only check `response.ok` swallow the failure → empty results, no error shown.

What IS enabled on the key (verified 2026-06-07):
- **Places API (New)** — `POST https://places.googleapis.com/v1/places:autocomplete`, `GET https://places.googleapis.com/v1/places/{placeId}` (header `X-Goog-Api-Key`, `X-Goog-FieldMask`).
- **Routes API** — `POST https://routes.googleapis.com/directions/v2:computeRoutes` (used by `src/lib/google-maps/server.ts` `computeRoutes`).
- **Geocoding API** — legacy `maps/api/geocode/json` still works (forward + reverse geocode in `google-maps/server.ts`).

This broke admin "Add manual outstation expense": the destination picker (autocomplete + place-details) used legacy Places → no suggestions → submit button disabled. Fixed by migrating those two routes to Places API (New) in **PR #49** (merged + deployed to prod). The rest of the feature (employee HR-ID lookup route, manual-distance override, editable destination) shipped in **PR #53** (merged + deployed). Any NEW Maps feature must use the v1 Places endpoints, never the legacy `maps/api/place/*`.

Cleanup note: a parallel session left a redundant branch `origin/codex/outstation-places-api-new` (165743b) with a DUPLICATE, unmerged Places fix — now obsolete since #49 is on main. Safe to delete to avoid a future duplicate/conflicting PR.
