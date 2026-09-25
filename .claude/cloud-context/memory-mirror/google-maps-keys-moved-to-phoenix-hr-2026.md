---
name: google-maps-keys-moved-to-phoenix-hr-2026
description: "Google Maps died system-wide on the dead GCP project's billing; keys repointed to phoenix-hr-2026 (active billing) 2026-08-09."
metadata: 
  node_type: memory
  type: project
  originSessionId: 61f121b7-dd6e-4e54-80e4-dc368c1c6543
  modified: 2026-08-09T16:15:39.005Z
---

System-wide Google Maps outage root-caused and fixed 2026-08-09. Every map surface (outstation,
marketing-requests, field-workforce route map, expense heatmap, outstation review map) shares two
Google Cloud API keys. They lived in the **dead GCP project `phoenix-workforce-498619`** whose
billing closed 2026-08-01 (same event that killed Cloud Run) — proven live: the deployed
`GOOGLE_MAPS_SERVER_KEY` returned `REQUEST_DENIED — "You must enable Billing on the Google Cloud
Project."` See [[railway-merge-is-the-production-deploy]] for the billing-death context.

**Fix applied:** repointed to the owner's separate live-billing project **`phoenix-hr-2026`**
(gcloud account `omarrr.g.3003@gmail.com`). Its keys: `phoenix-browser` (uid
`43dc95c2-e669-4402-99f6-8a42a7f67dfe`, maps-backend only) → `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`
(ends `…eosY`); `phoenix-server` (uid `858e5b0b-17fb-414a-aea6-8f71dbae26b8`,
geocoding/places/routes/calendar) → `GOOGLE_MAPS_SERVER_KEY` (ends `…Fv3k`). Read the strings with
`gcloud services api-keys get-key-string <uid> --project=phoenix-hr-2026`. Both set on Railway
production via local CLI + GitHub secrets + `.env.local`. Verified live: server key geocode `OK`;
browser key rendered 26 tiles from `phoenix-hr.satopharma.com` with no `gm_authFailure`.

**Landmines:**
- Railway is a source-connected build, so `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` is baked at BUILD
  time — a var change alone won't take; you must force a rebuild (`railway redeploy --yes
  --from-source`). A plain `railway redeploy` reuses the image and keeps the OLD baked key.
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` is now **`b5844ef302e19ee05bd65aaf`** — a fresh VECTOR Map ID
  created 2026-08-09 in phoenix-hr-2026 and set on Railway + GitHub + `.env.local`. The old
  dead-project Map ID was removed first (only `outstation-review-map.tsx` reads it; it falls back
  to classic markers when blank). Created via the **Map Management API** (NOT the console):
  `POST https://mapmanagement.googleapis.com/v2beta/projects/phoenix-hr-2026/mapConfigs`
  `-d '{"display_name":"...","map_type":"VECTOR"}'` — REQUIRES enabling `mapmanagement.googleapis.com`
  AND an `X-Goog-User-Project: phoenix-hr-2026` header (user-cred tokens otherwise bill quota to
  gcloud's shared project and 403). `mapId` is in the response `mapId`/`name` field. Verified live:
  AdvancedMarkerElement created on the prod origin with this key+mapId, zero errors.
- The stale **GitHub secret `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` was DELETED 2026-08-09** (owner
  authorized it; `gh secret delete` succeeded — `gh secret list` now shows only
  `GOOGLE_MAPS_SERVER_KEY` + `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY`). This closed the re-break
  landmine where a revived GitHub→Railway sync ([[railway-token-expired-breaks-all-secret-sync]])
  could have re-added the dead Map ID. If you create a fresh Map ID in phoenix-hr-2026, re-add the
  secret AND set the Railway var, then rebuild from source.
