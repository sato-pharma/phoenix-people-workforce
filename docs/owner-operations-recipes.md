# Owner operations — the recipes

When the owner says "validate X", "link X", "merge the copies" or "fix that record", Claude does it
itself, from the code, against production. It never does it in his Chrome, never by clicking through
a screen, and never by handing him click-by-click steps unless his message asks for steps (memory note
`when-he-says-do-it-claude-does-it-from-the-code`, 25 Nov 2026).

This file exists so that the next session starts from the recipe instead of re-reading the domain
code. **Every time an operation is done for him for the first time, add its recipe here**: the
function or route, the input shape, the ids it needs, and the read that proves it landed. Every
session reaches this file through that memory note, which the always-loaded `MEMORY.md` names.

Each recipe uses the app's own domain code (the same path a screen takes), so its checks still apply.
That means no hand `insert`/`update` for anything a route can do.

## How to run them: `scripts/owner-ops.ts`

Every recipe below is a subcommand of one committed runner. It acts as B-10 the way a route handler
builds the caller (his login row, the lifecycle gate, `createAccessContext`), and calls the same
domain function the route calls. It never goes through a screen, his browser or the spare laptop.

```bash
node --env-file-if-exists=.env.local --experimental-strip-types --experimental-specifier-resolution=node \
  --import ./tests/register-alias-loader.mjs scripts/owner-ops.ts <job> <flags>
```

- **It is a dry run unless `--apply` is on the command line.** A dry run goes through every check
  and refusal the real save has. The app's own test-account fence (`src/lib/auth/test-dry-run.ts`)
  answers each write without sending it, and the runner lists what it would have written.
  `--apply=yes`, `--aply` and a bare `apply` never write: each one is refused.
- **`--apply` refuses a tree that is behind `origin/main`.** Run it from a fresh checkout.
- 🔴 **Run `--apply` on production only when the owner's own message orders that specific job.**
  The dry run is always allowed, so run it first and read its list.
- **Every run ends with a proof read:** the employee's draft workspace (`getMarketingRequestDraftWorkspace`,
  the read behind `GET /api/marketing-requests/drafts`). Exit 2 = bad arguments; 1 = refused by
  the app; 3 = written but the proof could not be read (do not re-run: the write happened).
- `--help` lists the jobs. Pinned by `tests/owner-ops-runner.test.ts`.

## Marketing

### Link a doctor's pharmacies to an employee (Super Admin desk entry)

- **Run:** `owner-ops.ts link-doctor --body <file.json>`
- **What it calls:** `createMarketingValidationRecord` in `src/lib/marketing-requests/service.ts`. This is
  the same path `POST /api/marketing-requests/validation` and a rep's capture take.
- **Body file:** the route's exact body:

  ```json
  {
    "onBehalfOfHrId": "<the employee, e.g. PD-0028 Sahar ElGallad>",
    "customers": [{
      "customerType": "clinic",
      "existingCustomerId": "<the doctor's marketing customer id, when the employee already holds them>",
      "displayName": "<doctor, Arabic as on the CRM list>",
      "speciality": "Paediatrics",
      "crmAreaSeatId": "<seat, e.g. SEAT-PED-REP-D26>",
      "crmCustomerId": "<the Phoenix CRM customer uuid>",
      "extractedAreaName": "<area, e.g. Port said - Domiat>",
      "extractedGovernorateName": "<governorate>",
      "pharmacies": [
        { "existingPharmacyId": "<uuid>" },
        { "displayName": "<pharmacy>", "venueType": "pharmacy", "capturedAddress": "<street address>",
          "extractedAreaName": "<area>", "extractedGovernorateName": "<governorate>",
          "vendorCodes": [{ "distributorId": 17, "distributorPharmacyCode": "<code>" }] }
      ]
    }]
  }
  ```

- 🔴 **A doctor the employee ALREADY holds is never saved twice.** Since #784 the desk save joins a
  doctor she holds under the same `crmCustomerId`, and only his pharmacies are written. The runner
  announces that join. A doctor of the same NAME held under no CRM id, or under another one, is still
  minted again by the app, so the runner refuses that body. Send it with `existingCustomerId` instead.
  This is how Dr Othman El Shewehy was saved twice for Sahar ElGallad on 25 Nov 2026 (22:49 and 23:12
  Cairo). The 23:12 copy is merged into the original since then (below).
- **`existingCustomerId` with no capture of the doctor only adds pharmacies** (`isDeskAttachEntry`,
  since 26 Nov 2026): his row, validation and contacts are left as they stand. Before that fix it
  "completed" him instead: it re-stamped his validation and added one more copy of his contact on
  every save. That is how Dr Othman got a third identical contact when Salah El Hol was linked at
  00:06; the two copies were switched off (audit rows), and one contact stands.
- **Distributor ids:** read `marketing_distributors` (25 Nov 2026: Ibn Sina 17, Overseas 19, Sofico 21).
- **Refusal "that pharmacy is not one you can attach":** the `existingPharmacyId` belongs to another
  seat. Send it as a new venue with its codes, then merge the old copy into it (below).
- **Proof:** the employee's workspace lists the doctor, and `pharmaciesByCustomer[<customer id>]`
  holds every pharmacy.
- First done for Dr Othman El Shewehy / Sahar ElGallad, 25 Nov 2026 (session 6c7fe3eb).

### Merge duplicate pharmacy copies

- **Run:** `owner-ops.ts merge-venues --survivor <kept id> --loser <copy id> --reason "<why: same shop, same codes>" [--employee <hr id>]`
- **What it calls:** `mergeMarketingVenue({ survivorId, loserId, reason })`, the function behind
  `POST /api/marketing-requests/venue-merge`. It moves links and requests to the survivor, switches
  the copy off and records the reason. Run it once per copy.
- **Refusal `[conflict]`:** the copy is already merged or inactive. Nothing is left to do.
- **Proof:** the workspace of every employee holding a doctor linked to either pharmacy, or of
  `--employee` if given.

### Merge a duplicate customer (a doctor saved twice)

- **Order:** merge the duplicate PHARMACY copies first (above), so both customers point at the same
  venues; then merge the customer.
- **Function:** `mergeMarketingCustomers` in `src/lib/marketing-requests/customer-merge.ts` (route
  `POST /api/marketing-requests/customer-merge`, body
  `{ "survivorId": "<kept>", "retiredId": "<copy>", "carryEvidence": false, "reason": "<why>" }`).
- 🔴 **It refuses a dev-preview session** (`assertRealSessionForDecision`: "A dev-preview session
  cannot merge two customers"). The spare's dev-auth headers are a preview session, so the spare route
  answers 403. Never work around that guard. The owner presses it himself, signed in as himself, on
  Marketing Requests → Customer Database → "Merge duplicate customers": the customer that stays, the
  customer to retire, the reason, then **Merge customers**.
- **Proof:** the copy's `marketing_customers.merged_into_customer_id` names the survivor and its
  `active` is false; the survivor's live links are unchanged.
- First needed for Dr Othman El Shewehy / Sahar ElGallad, 25 Nov 2026: the four pharmacy copies merged
  from the spare (HTTP 200 each); the doctor merge was refused (403) and left for the owner.
- 🔴 **Two customers of different kinds never merge** ("These two are different kinds of customer"):
  the screen's OK box appears, then the database refuses. Read both `customer_type`s first. The
  25 Nov desk entry was typed `doctor` (legacy, no new customer gets it) and the form's copy `clinic`,
  so the original was set to `clinic` (audit row) before the merge. A desk entry uses one of the
  form's four kinds: `hospital`, `clinic`, `account`, `other`.

### Put a map pin on a pharmacy already saved

- **Run:** `owner-ops.ts pin-pharmacy --pharmacy <id> --lat <latitude> --lng <longitude> [--employee <hr id>]`
- **What it writes:** `marketing_pharmacies.captured_latitude` / `captured_longitude` / `captured_at`, with
  `evidence_status = 'pending'`. That is the desk-entry rule for a pin without a shop photo.
  Validation and links are untouched.
- **What it refuses:** a merged, inactive or already-pinned pharmacy, and a point outside Egypt.
  The update itself only matches a pharmacy whose latitude is still empty. Egypt's latitude and
  longitude ranges overlap, so a swapped Cairo or Delta pin still passes the Egypt check: read the
  printed pin row.
- **Proof:** the pin row, then the linked employees' workspaces.

## Phoenix CRM

### Put doctors on a rep's list for her to validate (and their hours)

- **Run:** `owner-ops.ts load-crm-list --seat <territory seat id> --body <file.json>`
- **What it calls:** the SFE's own list-template path. `buildListTemplateFor` builds the territory's
  template (the download, seat marker included), the runner writes the body's rows into it, and
  `importListTemplate` uploads it. That is the function behind `POST /api/phoenix-crm/list/template/import`.
  The route's gate (`assertPermission(…, "phoenix_crm", "approve")`) and its audit line run as well.
  Every check of the upload applies: the seat marker, the row rules, and the database's skip for a name
  already on the list.
- **Body file:** rows in the template's own column keys.

  ```json
  {
    "customers": [
      { "listType": "PM", "name": "<doctor, Arabic as he is known>", "speciality": "Chest",
        "daysAndHours": "Tue 6:00 PM - 7:00 PM", "whereToFind": "<hospital — town, clinic, day>",
        "note": "<a line for the rep>" }
    ],
    "hours": [
      { "listType": "PM", "name": "<a customer already waiting to be validated>", "daysAndHours": "Tue 7:30 PM - 8:30 PM" }
    ]
  }
  ```

- **What lands:** each `customers` row is a `pending` customer (origin `new`) under the rep's
  **To validate**. That is how she is asked: no notice goes to a rep from here, and Phoenix CRM sends
  no email. She validates him at the door, seating him in the building within 300 m. The place is
  never a column. `hours` sets the days and hours on a customer still pending and placeless, and
  nothing else about him.
- **The seat:** the rep's territory seat (`SEAT-…`), read from `au_v_org_tree` by her name. It is never her HR id.
- **AM or PM at a hospital follows the seating** (the place's `session`), never the list. No app door
  moves an existing customer between AM and PM.
- **Proof:** the runner reads the territory's rows for every name in the body (status, origin, hours, where to find them).
- 🔴 **Until 26 Nov 2026 the first sheet's hours never landed**: the payload sent `intake_timings`
  and the loader reads `timings`. That affected 1,667 customers, 6 Oct to 26 Nov. After the fix a new
  customer's hours land with him. For the 26 Nov rows they were set afterwards through `hours`.
- First done for Nora Kamal (Pedia, Menoufia 1, `SEAT-PED-REP-D12`), 26 Nov 2026. The owner sent the
  Tuesday timetable of مستشفى الشروق الخاصة. Three doctors were added: محمد محروس (Chest), محمد أنور (ENT)
  and احمد الجوهري (Chest). احمد توفيق was already waiting and got his hours.

### Validate waiting doctors from a building's timetable

- **Run:** `owner-ops.ts seat-in-building --seat <territory seat id> --building <shared place id> --customers <id,id,…> --reason "<why, 10 to 500 characters>"`
- **What it calls:** `seatWaitingCustomersInVenue` in `src/lib/phoenix-crm/server/place-move.ts` (Super Admin only), which
  calls `phoenix_crm_seat_waiting_customers_in_venue`. It seats each customer at the building's own point, with the
  building's timetable as his photograph, exactly as the move into a building does. It never validates anybody.
  `settleVenueTimetable` then reads the board for each of them, and the database validates only a customer the board
  names (`match`) with no review waiting. A board that does not name him leaves him waiting.
- **What it refuses:** a building that is retired, still waiting for the Super Admin, or has no timetable on file; a
  customer who is not on the seat, is a pharmacy, is not waiting, already has a place (the move is his door), or has
  no hours yet (set them first with `load-crm-list`'s `hours`). The runner reads all of this first and fails with
  the same refusals before anything is written.
- **The ids:** the building from `phoenix_crm_shared_places` by seat and name; the customers from
  `phoenix_crm_customers` by seat and name, `status = 'pending'`.
- **Proof:** each customer's status, `validated_at`, his new place and the board's verdict for him.
- First done for Nora Kamal (`SEAT-PED-REP-D12`), 26 Nov 2026: the four doctors on the Tuesday timetable of مستشفي الشروق.

### How these were run before the runner

On 25 Nov these routes were called on the SPARE laptop's dev server with dev-auth headers
(`x-phoenix-role: Super Admin`, `x-phoenix-hr-id: B-10`, `Origin: http://localhost:3000`) through
`~/.claude/scripts/spare.ps1`. That broke whenever the spare's Wi-Fi dropped, which it did at 22:44
that night. A scratch script that fabricates a Super Admin viewer was refused by Claude Code's safety
check on 9 Oct 2026. `scripts/owner-ops.ts` is the reviewed, committed form: it reads B-10's real
login row instead of fabricating one. A new desk job becomes a new subcommand there, with its recipe here.

## Phoenix CRM

### Approve a rejected validation after all ("Approve it after all")

- **What it calls:** `restoreValidation(viewer, { reviewId, note })` in `src/lib/phoenix-crm/server/validation-reviews.ts`,
  the same path `POST /api/phoenix-crm/validation-reviews/restore` takes. The viewer is
  `resolvePhoenixCrmViewer(createAccessContext({ hrId: "B-10", loginId, role, source: "session" }))`, built
  from his one active, non-test `app_auth_users` row (as `liveAccessContext` in `scripts/owner-ops.ts` does).
  There is no runner job for it yet. On 26 Nov 2026 it ran from a throwaway file in the worktree with the
  alias loader and `--env-file-if-exists=.env.local`, one call per review id.
- **Ids:** the place's ONE `phoenix_crm_validation_reviews` row (`place_id` is unique). A customer with two
  places has two reviews. The second answers `validated: false` once the first has validated him, which is
  correct.
- **Proof:** the customer is `active` with `validated_at`, the place is `active`, the review is `approved` by `B-10`.

### A one-time location-only exception (no photo kept)

- **Only on his word for the named cases.** The standing rule is "no customer is validated without a photo"
  (`.claude/rules/phoenix-crm-place-checks.md`). On 26 Nov 2026 he allowed it once, for Hadeer Abdelnaser
  (B-95) and the doctors with no signboard naming them: Siham Sobhy, Hisham Samih Ismail, Wael Abu El Kheir,
  and Hisham Khodeir (both clinics). His words: "exception only for this time, for this rep, location only, no photo".
  Ahmed Eid was left alone, because he has no capture and so no location.
- **How:** back up the places, reviews and customers first (`phoenix_crm_backup_20261126.paper_exception_*`).
  Then `photo_path = null` with `trusted_basis = { kind: "owner_exception_location_only", decided_by_hr_id,
  decided_on, reason, removed_photo_path }`. The `phoenix_crm_places_photo_or_trusted` CHECK needs one of the
  two. The stored file stays in storage, and its path stays in `removed_photo_path`. Only after that comes
  the take-back above, so the line copies are made without the photo. The point stays the photo's own reading.
