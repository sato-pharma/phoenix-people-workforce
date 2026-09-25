---
name: google-routes-returns-zero-routes-for-a-governorate-centroid
description: "Google Routes answers HTTP 200 with an EMPTY routes array when EITHER endpoint has no road near it — and a missing GOOGLE_MAPS_SERVER_KEY produces the identical all-null result, so a config outage reads as a bad destination. Only desert governorate centres are roadless; the 2026-08-23 incident was the ORIGIN, not the destination."
metadata: 
  node_type: memory
  type: project
  originSessionId: b29ffadf-7b7e-4be7-9890-37bcfdad8fd1
  modified: 2026-08-23T16:14:37.354Z
---

Measured live 2026-08-23 against the production `phoenix-hr-2026` server key while diagnosing
"Google Maps could not calculate distance" on the admin outstation manager-expense modal.

**Correction — this file first blamed the destination and that was wrong.** The owner had picked
*Ebshaway el Fayoum*, which routes fine. The real cause was the **origin**: the manager's stored
residence, saved at the Egypt country centroid. See [[employee-residences-were-saved-at-the-egypt-country-centroid]].
Routes fails on **either** endpoint, and the message only ever named the destination.

**Routes API returns `200 {}` — an EMPTY `routes` array — when a coordinate has no road near it.**
Not an error, not a 4xx. Some governorate centres are open desert and some are not:

| Coordinate | routes |
| --- | --- |
| Alexandria · Hurghada · Siwa · Sharm · Riyadh · Dubai | 1–2 ✅ |
| **Faiyum** governorate centre `29.35647,30.61999` (APPROXIMATE, admin_level_1) | **2** ✅ 135 km from Cairo |
| New Valley · Marsa Matrouh · Red Sea · South Sinai **centres** | **0** ❌ |
| Egypt country centroid `26.820553,30.802498` | **0** ❌ from and to everywhere |

So "it's a region" does **not** predict failure — most Egyptian governorate centres are near a road,
and `administrative_area_level_2..4` (markaz/qism) centres *are* the town. Measured: Ibsheway markaz
109.3 km vs Ibsheway locality 109.0 km — **0.3 km apart.** #2338 therefore narrowed
`BROAD_REGION_TYPES` in `app/api/admin/outstation/place-details/route.ts` to level_1/country/
colloquial/archipelago/continent, so the orange "this is a region" banner stops firing on ordinary
towns. Don't put levels 2–4 back.

**All three waypoint forms fail identically** for a genuinely roadless point — `latLng`, `placeId`,
and `address` string. Places `searchText` with `includedType: "locality"` returns *the region
itself*, so an automatic "main city" substitution is a guess — and this field drives a payment.
Don't build one.

**The quieter trap: a missing key is indistinguishable from a missing route.** `computeRoutes()` in
`src/lib/google-maps/server.ts` returns all-nulls when `GOOGLE_MAPS_SERVER_KEY` is unset, exactly
like a genuine zero-route answer — so the system-wide Maps death of 2026-08-01
([[google-maps-keys-moved-to-phoenix-hr-2026]]) would have printed "could not calculate a driving
route to the selected destination" and sent the reader hunting the destination. Fixed in #2338:
`isGoogleMapsServerKeyConfigured()` is checked first and returns **503 `maps_not_configured`**;
`src/lib/outstation/distance-failure.ts` owns all three messages (`maps_not_configured` 503,
`residence_not_geocoded` 422, `route_not_found` 422).

Only two callers of `googleDirectionsRoute` exist. The other,
`validateCapturedLocation` in `src/lib/outstation/service.ts`, routes from **captured GPS**, so
zero-route is unlikely there and it already falls back to a cached route.

**Probing the key:** the browser key answers `REQUEST_DENIED — "API keys with referer restrictions
cannot be used with this API"`, which proves it is referrer-restricted *and* that billing is live
(a dead-billing key says "You must enable Billing" instead). Server key ends `…Fv3k`.
