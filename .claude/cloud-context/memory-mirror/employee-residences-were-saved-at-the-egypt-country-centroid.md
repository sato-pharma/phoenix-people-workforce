---
name: employee-residences-were-saved-at-the-egypt-country-centroid
description: "23 employee_locations rows held 26.820553,30.802498 — Google's geocode for the bare word 'Egypt' — because googleGeocodeAddress took results[0] blindly and the API answers OK with the COUNTRY when nothing else matches. All 19 active rows repaired in prod 2026-08-23; the source hole closed in #2340."
metadata: 
  node_type: memory
  type: project
  originSessionId: b29ffadf-7b7e-4be7-9890-37bcfdad8fd1
  modified: 2026-08-23T16:28:20.059Z
---

Found 2026-08-23 in production (`ozucdzovmcqvepbozvqf`) while diagnosing the outstation
"Google Maps could not calculate distance" error. **The destination was never the problem — the
origin was.** See [[google-routes-returns-zero-routes-for-a-governorate-centroid]].

**`26.820553, 30.802498` is what Google returns for the bare word "Egypt".** Open desert, no road,
so Routes answers `200` with an **empty** `routes` array from that point to *anything* — Ebshaway,
Cairo, Alexandria alike. 23 rows held it, 16 of them active, mostly stamped
`updated_at = 2026-08-10 13:16:46+00`.

**The generator, not just the symptom.** `googleGeocodeAddress` in `src/lib/google-maps/server.ts`
read `results[0]` unconditionally. The Geocoding API **never says "not found"** — it climbs the
hierarchy and returns whatever *did* match, with `status: OK`. Every query in this repo appends
`", Egypt"`, so the floor is always the country, returned as its centroid typed
`["country","political"]` and stored as `geocode_status = 'success'`. Closed in **#2340**:
`src/lib/google-maps/geocode-precision.ts` refuses a `country`-typed result (and the centroid
coordinate itself). **`administrative_area_level_1` is deliberately still allowed** —
`destination-geocode.ts` geocodes governorates on purpose and most Egyptian governorate centres
route fine. `residence-geocode-policy.ts` already guarded the narrower case (all address parts
empty ⇒ the literal string "Egypt"); #2340 guards the general one.

**The second failure mode: a WRONG coordinate never self-heals.**
`getResidenceLocationForEmployee` only geocodes when lat/lng is NULL, so a bad row looks resolved
forever. **Never write a fallback coordinate — leave it NULL.** NULL is the safe state: the route
answers `missing_residence` naming the employee.

**Repaired in prod 2026-08-23 — 19 active rows, in two passes**, each with a precondition on the
centroid pair: 16 re-geocoded from `employees.residence_address`, then 3 more from an owner-filled
xlsx. Verified 16/16 route (60.7–633.6 km) while the centroid still returns 0; final counts
**0 active at the centroid, 4 resigned remaining.** Also left 9 active rows with NULL coordinates —
that state is correct and self-heals.

**Owner answers worth keeping:** AA Anwar Gaweesh and AB Sahar Khalil both live at
**مساكن شيراتون** (Sheraton Al Matar, El Nozha, Cairo) → `30.10093, 31.37471`. CN-0001 Mostafa
Elbadry chose **المجاورة السابعة / New Cairo 1** → `30.06148, 31.45318`.
**Trap: the bare word "شيراتون" geocodes to the Sheraton HOTEL in Dokki, Giza — 22 km wrong.**
Qualify it as مساكن شيراتون / Sheraton Al Matar. Fetch Arabic addresses base64-encoded out of
Postgres; the shell mangles them otherwise.

## 2026-08-23 final state — do NOT re-send the file

**0 active employees at the centroid; 106 of 112 hold a real routable coordinate.** The last **6**
have no residence address recorded anywhere, so there is nothing to geocode: **A-3** Samaa Mosaad
Khalil (Qppv), **AI-0009** Omayma Wael, **AI-0010** Omar Tamer, **AI-0011** Mohamed Khaled,
**AI-0012** Hanan Safwat, **PD-0011** Mohamed Eldomiaty (all Medical Representatives but the first).
They get a clean `missing_residence` refusal, never a wrong distance.

`xlsx/Residence addresses - 6 employees with none on file 2026-08-23.xlsx` was sent twice and
returned empty both times. **The owner said on 2026-08-23 he would backfill these himself — stop
sending the file and do not chase him for it.**

Three more (CN-0006, PD-0008, PD-0009) held addresses with NULL coordinates and were written the
same night after route-testing: `30.5685637,31.7773138`, `30.0727177,31.2184372`,
`30.0556102,31.3565363`. Their `geocode_status` moved `pending_import_review` → `success`, which is
exactly what the app writes on its own.

**When he does backfill through Employee Management, nothing more is needed from a session** — the
save geocodes automatically, and since #2340 a country-level answer is refused rather than stored,
so the row goes to `failed` with the coordinate columns omitted instead of landing in the desert.
