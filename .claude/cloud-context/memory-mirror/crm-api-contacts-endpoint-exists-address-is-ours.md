---
name: crm-api-contacts-endpoint-exists-address-is-ours
description: "The iReports360 API DOES have a contact/doctor list endpoint since 2026-08-29 (agents-contacts, carries lat/lon); the check-in address Phoenix shows is still Phoenix's OWN reverse-geocode, not vendor data"
metadata: 
  node_type: memory
  type: project
  originSessionId: 9fb33483-9e95-4e1b-b031-175186fde22c
  modified: 2026-08-28T15:04:36.352Z
---

## ⚠ SUPERSEDED IN PART — 2026-08-31: the contacts endpoint NOW EXISTS

**`GET /api/ReportsApi/agents-contacts?agentId=<id>` is LIVE.** Measured against the live API
2026-08-31. Everything dated 2026-08-28 below was CORRECT WHEN WRITTEN and is left untouched: the
vendor shipped this endpoint in the intervening three days. `/swagger/v1/swagger.json` served **9
paths on 2026-08-28 and serves 10 today**, and the 10th is exactly this one — that delta is the
proof, so do not read the old section as an error to fix.

- **`agentId` is genuinely REQUIRED** — omitting it returns HTTP 400 `"agentId is required."`.
  There is NO bulk mode; the whole field force is 68 calls. The sweep took **17.1s for 68 agents,
  0 errors** — that is over half of cron-job.org's hard 30s cut, so it must not share a tick with
  other work.
- Per contact it returns exactly: `contactID, contactName, speciality, grade, lat, lon, address,
  region`. **`lat`/`lon` are STRINGS** (`"26.1766948"`), unlike `/checkins` where they are numbers.
- **This is NOT a drop-in replacement for the `ContactsList.aspx` scrape** — measured against the
  9,518 stored contact links across the same 68 agents: **9,331 matched, 64 API-only, 192
  scrape-only.** It also carries no `phone`, no Arabic name, no `city`/`zone`, all of which the
  scrape supplies and `ireports360_contacts` stores (2,929 phones, 9,513 Arabic names). Keep the
  scrape; treat this as a COMPLEMENT.
- **What it adds that nothing else has: the CONTACT'S OWN registered GPS.** 6,067 distinct doctors
  (64.6% of returned rows) carry a usable lat/lon. `public.ireports360_contacts` has **no lat/lon
  column at all** today. This is a registered clinic location, categorically different from the
  check-in coordinate described below, which is **where the rep stood**.

**There is no contacts endpoint on the iReports360 Reporting API, and there never was.** Confirmed
2026-08-28 from three independent sources that agree exactly:

1. The owner's own **Postman collection** (`iReports360_API_Postman_Collection.json`) — 7 requests:
   `POST /api/ReportsApi/login`, `GET /visits`, `GET /checkins`, `GET /weekly-plans`,
   `PUT /weekly-plans/{planId}/status`, `GET /monthly-plans`, `PUT /monthly-plans/{planId}/status`.
2. The owner's own **PDF** (*iReports360 Reporting API Documentation*, v2.0 June 2026) — same list,
   and its **ER diagram shows the `Contacts` table holding only `Id` and `ContactName`**. `Address`
   is on **`VisitChecks`** (the check-ins table), not on the contact.
3. The **live API** — `/swagger/v1/swagger.json` enumerates 9 paths total, and 20 candidate contact
   URLs across four controller spellings and both casings all returned **404**.

**So a "doctor list with address" must be assembled from plans + check-ins.** It is buildable today
with no vendor change — do not tell the owner it is blocked on them (I did, and was wrong):

- name / grade / speciality / region → `ireports360_plan_entries` (measured 0% blank on grade and
  region, 0.2% on speciality)
- address → `ireports360_checkins.address`

**The critical part: that address is 81% OURS, not the vendor's.** Of 109,438 mirrored check-in
rows, the vendor's `raw_payload->>'address'` is populated on only **20,954 (19.1%)** — the live API
returns an **empty string**, not null, on the rest (August 2026: 4,991 real of 15,655). Phoenix
fills the other **88,474** itself by reverse-geocoding the lat/lon via
[[locationiq-geocode-provider]] — `src/lib/crm/checkin-geocode.ts`, the sync, and
`scripts/backfill-checkin-addresses.ts`. That is why the mirror reads 99.99% populated while a live
API probe reads 19.1%: **they are not the same field.** A probe of the vendor API will therefore
always understate address coverage — measure the column, not the payload.

**Coverage and quality**, August 2026 weekly plans (9,749 distinct doctors, 79 reps, 31/115/234
doctors per rep min/median/max):

| | doctors |
| --- | --- |
| with at least one address | 8,633 (**88.6%**) |
| exactly one distinct address | 1,336 |
| 2–3 distinct addresses | 2,278 |
| **4 or more** | **5,019** |

Average address length 89 characters, so these are detailed strings, not "Cairo, Egypt". But it is
**where the rep stood**, geocoded per check-in — not a registered clinic address — so most doctors
carry several drifting variants and any UI must pick one (most recent, or most frequent). A bad GPS
fix yields a confidently wrong address: `src/lib/crm/checkin-coords.ts` rejects out-of-Egypt
coordinates precisely because "Najaf, Iraq" was one of ours. See
[[gps-checkins-are-a-partial-feed-never-score-a-rep-on-them]] and
[[crm-checkin-address-reverse-geocode-backlog]].

**NEVER TRUST THIS PDF'S FIELD TABLES — the live endpoints return MORE than it documents, and one
field it documents is empty.** Measured 2026-08-28 against the mirrored `raw_payload`, which is what
the vendor actually sent:

| Endpoint | Documented | Live | Undocumented extras |
| --- | --- | --- | --- |
| `GET /visits` (§4) | 16 | **20** | `contactGrade` 70.4%, `speciality` 70.3%, `region` 70.4%, `regionID` 70.4% |
| `GET /checkins` (§5) | 8 | **9** | `contactGrade` 100% |

And `visits.customerName`, documented as "Facility name", is **0% populated** — 0 of 126,410 rows.
So there is no facility name to show, but there IS a full doctor profile riding on every visit.
**This is why the owner said "there is much data in the API, you can't read it" — reading the PDF
instead of the wire is how you conclude the contact data is missing.** Census the payload keys
before ever telling him a field does not exist.

Because of those extras the reconstructed list is far richer than plans alone. June 2026 onward,
union of visits + check-ins + plan entries, restricted to reps whose `agent_hr_id` is mapped:
**135 reps, 14,130 rep-doctor rows, median 110 doctors per rep (max 347)** — name 98.8%, grade
98.8%, speciality 98.0%, region 98.0%, address 83.7%. That is every field the owner named for the
DM's doctor-list tab.

**Monthly plans are fetchable but have NEVER been synced.** `ireports360_plan_entries` holds 162,264
rows, **all `plan_kind = 'weekly'`**, zero monthly, despite the table carrying `plan_month`,
`plan_year` and `plan_frequency` columns for them. `GET /monthly-plans?month=&year=` works (2,409
rows for August 2026) and uniquely carries **`frequency`** — the planned calls per doctor per month,
which is the real coverage denominator. Only ~17-21 agents file one, against ~79 with weekly plans.

**Plan status enum** (both plan endpoints): `0` New, `1` Supervisor Verified, `2` Area Manager
Verified. The two `PUT .../status` endpoints exist and are the write-back path for a DM verifying a
rep's plan — `src/lib/crm/client.ts` deliberately does not implement them, and its header says not
to add them without the owner asking. **He asked, 2026-08-28.**
