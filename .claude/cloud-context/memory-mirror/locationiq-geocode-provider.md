---
name: locationiq-geocode-provider
description: "LocationIQ added as free first-choice geocoder for CRM check-ins + sales normalizer, Google as accuracy fallback — PR #1271 MERGED, live in staging+prod"
metadata: 
  node_type: memory
  type: project
  originSessionId: c35c2937-705a-47b4-9331-11b69e2b9d5d
  modified: 2026-07-23T12:03:03.366Z
---

Built 2026-07-23: `src/lib/geocoding/locationiq.ts` — LocationIQ (free tier) tried first for
geocoding, Google used as a fallback only when LocationIQ's match is low-confidence. Scope is
deliberately narrow: **CRM check-in reverse geocoding** (`src/lib/crm/checkin-geocode.ts`, wired
into `crm/sync.ts` + `scripts/backfill-checkin-addresses.ts`) and the **sales normalizer's forward
geocoding** (`pharmacy-geocode.ts`, `brick-centroids.ts`) ONLY.

**Explicitly untouched, stays Google-only:** outstation (reverse-geocode + destination-geocode +
distance/manager-distance), marketing-requests reverse-geocode, employee-directory forward
geocode, and ALL Routes/Directions calls (`googleDirectionsRoute`/`googleRouteThroughStops`/
`googleDistanceMatrix`) including `crm/rep-day.ts`'s driving route. Owner's own words: routing
feeds expense/reimbursement numbers, don't touch it.

**Why:** owner-driven cost question ("would real-time CRM sync cost more") led to discovering
Google Geocoding API usage across the codebase; owner chose to swap the free-tier-eligible piece
to LocationIQ but demanded accuracy stay primary ("cost is important but accuracy matters more").

**Design — confidence gate, not a blind swap:** LocationIQ has no literal confidence field.
`scoreReverseConfidence`/`scoreForwardConfidence` are heuristics from what the API actually
returns (address-component granularity for reverse; OSM class/type + importance for forward).
`LOCATIONIQ_CONFIDENCE_THRESHOLD = 90` (owner raised from an initial 75 same-session) — at 90,
only `house_number+road` reverse matches and precise-POI-class forward matches are accepted from
LocationIQ; everything else (bare road, suburb/city-only, highway-class, place/admin-class
matches) falls through to Google. `brick-centroids.ts` additionally requires LocationIQ to pass
the PRE-EXISTING `centroidPassesRegionGate` (ground-truth governorate check) — stronger than the
heuristic score, never relaxed.

**Live-API findings (verified 2026-07-23, not just unit-tested):**
- LocationIQ defaults to **Arabic** responses ("القاهرة" not "Cairo") — silently breaks
  `GOVERNORATE_TO_REGION` matching (English-keyed). Fixed by forcing `accept-language=en` on
  every call. This would have been a silent, hard-to-notice production bug.
- The markaz-equivalent Nominatim field is inconsistent across real responses — sometimes
  `state_district`, sometimes `county`. Both are checked (state_district preferred).
- Confidence gate validated against a real ambiguous case: forward search "Al Serw, Damietta"
  matched an unrelated street (class=highway, importance 0.05, scored 65) — correctly rejected,
  fell through to Google instead of accepting a wrong free result.

**Status:** PR #1271 merged to main. ~~`LOCATIONIQ_API_KEY` added to both Cloud Run services~~ **[CORRECTED 2026-08-27: that placement is dead — GCP has been `BILLING_DISABLED` since 2026-08-01 and production is Railway. If this key needs checking or rotating, it is a Railway variable on `phoenix-people-workforce`, not a Cloud Run env var.]**
(staging `phoenix-hr-staging` us-central1, production `phoenix-hr` europe-west3) via Console by
owner, verified live (new revisions serving 100% traffic, HTTP 200, no errors in logs). Unset key
degrades to pure pre-PR Google-only behavior everywhere — zero-risk rollback via env var removal.

**Open follow-up (deferred by owner):** "geo-to-brick enrichment" idea — parse a geocoded raw
address into discrete fields (town/markaz/governorate) and cross-reference them to Phoenix's own
brick/region master data, exposing `PHX brick` / `PHX brick ID` / `PHX region` / `PHX region ID`
as derived fields wherever geocoding happens. Much of the hard part already exists
(`scoreCustomerBrick` in `src/lib/sales/normalizer/geo-validate.ts`, already used by
`customer-suggest.ts` as a confidence-scored — never auto-written — brick suggestion). Owner is
mid-edit on bricks/regions data as of 2026-07-23 and asked to wait until that's finished before
starting this. Key open decision when resumed: should the new fields be informational/suggested
only (safe, matches existing pattern) or actually drive brick assignment (bigger risk — bricks
are the LOCKED authoritative-geography domain, see [[sos-brick-authoritative-geography]]).

See also [[whatsapp-business-api-deferred]] (raised same session, separate deferred idea).
