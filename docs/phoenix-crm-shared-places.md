# Phoenix CRM — shared places: validate the polyclinic once, seat its doctors

The account behind the rule. The rule itself is two bullets in module memory —
`.claude/rules/phoenix-crm-validation.md` (the venue, its signboard mode, the timetable read, the two
new refusal reasons) and `.claude/rules/phoenix-crm-approvals.md` (the three-a-day cap and its three
enforcement points). Read those first; this file is why they say what they say.

## What was broken

A Phoenix CRM place is validated at its door: a live signboard photo that **must carry the customer's
own name** (owner, 2026-10-08 — "require the customer's name always"), plus two GPS readings each
inside 250 m of each other. That works for a doctor with his own clinic.

It cannot work for a polyclinic. The signboard names the **building**, five customers receive behind
one door, and each of them needed his own capture at the same spot where the sign could never name
him. So they stayed unvalidated — and an unvalidated customer's visits are saved and score nothing.
The rep's work on those doctors was invisible in every call rate and every KPI.

## His words, 2026-10-09 (Arabic, in chat)

Validate the polyclinic itself **once**. Then register each doctor's times inside it — "from X to Y
and from X to Y" — at most **three a day**. He uploads a photo of the timetable showing the names of
the people he wants to add, **at each one**. The polyclinic's location is taken once, so seating needs
no location; the location is taken on the normal visit. And:
"**من حق الادمنستريتور ان هو يراجع الجدول ويبص**" — the administrator has the right to review the
schedule and look at it.

On the Google listing check, asked directly: *"understand, but even if no uh, Google check, he must
validate by a live photo and location."*

His eight decisions, each asked and answered in chat the same day:

1. **A shared place is a venue only** — on nobody's list, takes no visit, counts in no call rate and
   in no KPI. The seated customer stays the one who is planned, visited and counted.
2. **The cap is three visits a day inside one shared place**, whatever the number seated there, and it
   bites **both** when he plans the day and at the door.
3. **Scope is every shared venue** — polyclinic, medical centre, hospital outpatient — carried as a
   `kind` on the record. The polyclinic is the first case, not the only one. **It was four kinds for
   an hour.** The medical tower shipped in #5670 and he took it off the same day, reading the chooser
   on the rep's own screen: *"remove medical tower option"*. Nothing had to be migrated — the table
   held 0 venues when the narrowing was written — and a tower is now captured as whichever of the
   three its own sign says.
4. **The rep validates it at the door**: live signboard photo bearing the venue's name, plus the two
   readings inside 250 m. Fixed for ever once validated; only the Super Admin and the SFE Manager may
   move it.
5. **No Google Maps listing check on a shared place** — that check is judged on the customer's name
   *from the list*, and a venue has no list name. The administrator's review is the human gate, and
   nothing changes for an ordinary AM account.
6. **Seating needs the timetable photo AND at least one weekday with at least one start time.** The
   end of a window stays optional, as everywhere else in the module.
7. **Two new refusal reasons**, seventh and eighth in the closed list: the timetable does not name this
   customer (`schedule_other_name`), and no timetable in the photo (`schedule_missing`). The existing
   "a photo of paper, not a building" reason is never offered on a timetable photo — it would be wrong
   by construction.
8. **A venue belongs to the seat that captured it, and is offered to nobody else.** Asked on
   2026-10-09, the evening the feature shipped, whether a polyclinic one rep captured should appear
   to the other reps covering the same building: *"No, every polyclinic appears only to the rep
   validated it. No sharing."* So `loadSharedPlacesFor` filters `.eq("seat_id", …)` and two reps on
   one building each capture it — those duplicate rows are **correct**, not clutter to tidy away. A
   venue carries the capturing rep's own evidence (his live signboard photo, his two readings, his
   `created_by_hr_id`); seating a customer on another rep's capture would stand that customer's place
   behind a photo his own rep never took. Widening the read to `.in("seat_id", …)`, or to a line,
   area, region or brick, is the defect this rule exists to stop.

## One timetable for the building, not one per doctor — his amendment, 2026-10-10

On 2026-10-09 this document argued the photo had to be per customer, and gave two measured reasons for
it. **He overruled both on 2026-10-10**, in chat: *"when he adds doctors, the three doctors we agreed in
the same polyclinic, ask him for only one set timetable, not for every doctor, send the timetable."*
A polyclinic has one timetable board on its wall; photographing it three times is three photographs of
the same wall, and the rep pays for it three times at the door.

Neither of the two reasons was wrong — they were **mechanisms that had to be replaced, not arguments to
repeat back at him**:

- `phoenix_crm_places_photo_uidx` was UNIQUE on `photo_path` across every place, so one image pointed
  at three seated rows could not be stored at all. It is **PARTIAL now** —
  `where shared_place_id is null` — so it still binds every place captured at its own door, where one
  photo really does mean one place, and lets the seated rows of one building share their board.
  🔴 **That index was also carrying something nobody had named: it made a seating idempotent.** A
  double-tapped save failed on the duplicate photo path rather than writing a second place. With the
  predicate in, nothing stopped it, so the refusal `already_seated` was added in its place, behind a
  `for update` lock on the venue row — one customer sits in one building once, and two saves in the same
  building serialise.
- The evidence stamp **named that customer**, which is exactly what made one image per doctor
  unavoidable. It stamps the **building's** name now
  (`Phoenix CRM shared place: <venue>`), which is what the photograph actually shows. The crop still
  happens and still has work to do — `stampBandFraction` is unchanged, and the timetable read crops the
  same band before the model sees it.

**Reuse is decided on the server, from the venue's own column — never by a flag on the body.**
`effectiveSeatedPhoto` (`server/shared-places.ts`) is the one place that answers "which photo is this
seating saved against": a path sent from the phone is a **replacement** of the board on the wall; no
path means the venue's `schedule_photo_path`; and a venue with neither raises `SEATED_PLACE_NO_PHOTO`,
which is now the refusal of the **first** customer in a building and of nobody else. The seated draft
therefore still has exactly four keys — a client that could ask for reuse could ask for someone else's
board.

Two smaller consequences, both deliberate:

- **A reused board carries no device skew.** Its photo slot was issued on another day, possibly to
  another rep, so the gap between slot and capture measures nothing at all; `photoSlotIssuedAt` is
  skipped when `reused` is true rather than being allowed to report a false skew.
- **The reused image is read through its own door.** `downloadVenueTimetablePhoto` (`server/photos.ts`)
  keeps every other condition — the path's territory, the seat's storage segment, `seat_id`,
  `purpose = 'place'` — and drops exactly one: `issued_to_hr_id`. The slot behind a building's board was
  issued to whoever photographed it, not to the rep seating the next doctor. For the same reason the
  save path skips `lookUpPhoto` when nothing was captured: a reused board belongs to every doctor behind
  that door, so the lookup would find the **first** one and report an unsaved seating as successful.

## Why a seated customer is an ordinary place row

Everything downstream already works off a place: the visit's distance check, `placesFor` and the
re-measure, the plan item's optional `place_id`, the move and retire audit, `brick_*` / `area_*` /
`region_*`. A seated customer therefore gets a normal `phoenix_crm_places` row with `shared_place_id`
set, the venue's point copied, `point_source = 'shared_place'`, `photo_path` the building's one timetable (its own
for the first customer, the venue's for everybody seated afterwards) and `schedule_check` its read. **Nothing else in the module has to learn a new shape** — and because the
row is an active place, the customer is on the Super Admin's Place checks page from the moment he is
saved, which is the administrator's right to review with no second audit shape.

## Where the implementation departed from the approved plan, and why

Six places. Each one is a narrower change than the plan assumed, found while reading the live schema
and the module's own invariants:

1. **`phoenix_crm_validation_reviews` is left untouched.** The plan widened it to carry a venue row.
   Its `place_id` and `customer_id` are NOT NULL and its place index is UNIQUE on `place_id`; widening
   all three would have made every reader of that table — the review board, the held-place set, the
   restore path, the reopened list — carry a row it cannot render. The venue keeps its own four
   decision columns and its own `phoenix_crm_decide_shared_place`.
2. **The door cap is a BEFORE INSERT trigger on `phoenix_crm_visits`**, not a rewrite of
   `phoenix_crm_save_visit`. The trigger catches every insert path, including any that does not go
   through that function, and leaves a 3.3 KB function body unedited.
3. **Neither `phoenix_crm_validate_customer` nor `phoenix_crm_add_place` needed rewriting** — both
   delegate to `phoenix_crm_insert_place`, so teaching that one function the two new columns and the
   new point source was the whole change.
4. **No second button on a to-validate row.** `CustomerRowAction` offers exactly one action per row
   (owner, 2026-09-29), so the polyclinic route is the **first question inside** Validate and inside
   Add another clinic, not a button beside them.
5. **Seated customers are not nested under each venue on the board.** They are already ordinary places
   in the waiting / in-use sections, so the Polyclinics section carries the venue plus its seated
   count rather than repeating rows the page already shows.
6. **The decide route is POST-only, and a rejected venue never appears on the board.** The Polyclinics
   section is drawn from `loadSharedPlaceBoard` in the page itself (a server component), so a GET
   would have been a second, unused public surface to gate.

One more, worth stating because it reads like an omission: the cap code
`phoenix_crm_shared_place_day_full` is **deliberately absent from `OUTBOX_SETTLED_CODES`**. That list
is mirrored and `tests/phoenix-crm-mobile-mirrors.test.ts` compares the two copies code for code — a
code only one side knows is exactly the drift that test exists to catch, and one side dropping a rep's
visit while the other keeps it is its worst shape. A capped visit therefore retries and ages out at
`OUTBOX_MAX_AGE_HOURS`, the keep-too-long direction that list already prefers for
`phoenix_crm_conflict`. The rep is told at the door regardless: the live save answers 409 with the
cap's own sentence.

## The migration

`supabase/migrations/20261010013001_phoenix_crm_shared_places.sql` — one file, additive, **rewriting
not one existing row**. It creates `public.phoenix_crm_shared_places` (RLS on, one `service_role`
policy, no `anon` or `authenticated` grant), adds `shared_place_id` and `schedule_check` to
`phoenix_crm_places` with the `point_source <> 'shared_place' or shared_place_id is not null` CHECK,
adds `shared_place_daily_cap` (default 3) to `phoenix_crm_settings`, widens the refusal CHECK to the
eight reasons, teaches `phoenix_crm_insert_place` the new columns, and adds
`phoenix_crm_create_shared_place`, `phoenix_crm_decide_shared_place` and the visits cap trigger. Its
rollback is quoted at the top of the file.

Applied 2026-10-09, staging first, then production, and verified in `pg_class` / `pg_proc` rather than
the ledger:

| | staging `cifwmndunmlxjhyjugxa` | production `ozucdzovmcqvepbozvqf` |
| --- | --- | --- |
| `phoenix_crm_shared_places`, RLS | present, `relrowsecurity` true | present, `relrowsecurity` true |
| new columns | `places.shared_place_id`, `places.schedule_check`, `settings.shared_place_daily_cap` | same three |
| functions | the five, including both new ones and the trigger function | same five |
| trigger | `phoenix_crm_visits_shared_place_cap`, enabled | same, enabled |
| `shared_place_daily_cap` | 3 | 3 |
| refusal CHECK | the eight reasons, read back verbatim | the eight reasons |
| rows rewritten | none | none — 0 venues, 0 seated places |

🔴 **Production's database URL in `.env.production.rls.local` is the direct `db.<ref>.supabase.co`
form, which does not resolve from this laptop, and `scripts/apply-sql-file.mjs` would have rewritten
it to the `aws-0` pooler — the wrong region.** Production answers on
`aws-1-eu-central-1.pooler.supabase.com`; staging's URL is already in pooler form and passes through.
Anything applying a file to production has to try `aws-1`, or it fails with "Tenant or user not found"
and reads like a bad password.

## The rejection that said nothing — measured on the board, 2026-10-09

The venue decision was exercised on the administrator's board the night it shipped, on the staging
project, with one venue approved and one rejected. The approval behaved. The rejection turned up two
holes, and the owner's answer to both was one sentence: *"fix the polyclinic rejection so the rep is
told the reason"*.

**1. The venue rejection raised no notice at all.** "Test Board Centre B" was rejected with the
reason *No signboard in the photo*: the venue retired, its two seated places retired, both customers
went back to To validate with `reopened_at` stamped — and nothing reached either rep.
`decideSharedPlace`'s own paragraph already said those customers get the existing
`phoenix_crm.validation_not_confirmed` notice; the call was simply never written. A refusal that
reopens work in silence is the exact frustration the 2026-10-08 feedback work was built to end (0 of
22 reopened customers re-validated, 40.8 hours average wait).

🔴 **And the six signboard sentences could not just be forwarded.** Every one of them is about THIS
CUSTOMER's own door — "take the photo at this customer's own entrance", "take a live photo of the
building and its sign" — and a customer seated in a polyclinic has no door of his own; that is the
whole reason the venue is captured once at its own. Forwarded as they stand, a rejection would have
ordered a rep to photograph an entrance that is not there. So a venue refusal gets its own wording
(`sharedPlaceRefusalRepText`): the lead says which photo is meant, the clause says what is wrong with
the VENUE's photo, and the action is the one that actually clears it — capture the polyclinic or
centre again at its door, then register the customer in it. The notice carries `via: "shared_place"`
and the VENUE's id in place of a review id, because a venue keeps its decision on its own row and has
no review row; a rejected venue is retired for good, so that is one idempotency key per refusal, for
ever. Withdrawal is unchanged: the key is still customer-first, so validating again clears the bell.

**2. The board then said nobody had chosen a reason.** Both reopened customers appeared under
"Waiting to be captured again (2)" reading "A rep" and *"No reason was chosen — refused before the
reason list existed."* while `no_signboard` sat on the venue row. `loadReopenedCustomers` looked both
the rep and the reason up on a `phoenix_crm_validation_reviews` row with `status = 'rejected'`, and a
venue refusal writes none. The fallback asks the two places that do hold it:
`loadSharedPlaceRefusalsForCustomers` takes each customer's latest RETIRED seated place, joins it to
its venue, and uses the venue's `refusal_reason` with the rep on the retired seating — the rep who
photographed the timetable. The venue's name is shown beside the reason, because a signboard reason
read against a customer's own capture says he photographed the wrong door.

## AM or PM at the building (owner, 2026-10-10)

His words: a customer in a polyclinic or hospital is added as AM or PM; planning that building as AM
shows only its AM customers and PM only its PM customers, never both for one customer; a visit counts
in the AM or PM KPIs by the session it was planned and made in; **three visits a day per building,
AM and PM together**, as before. Asked directly, his answers: the choice is on the **seating**
(customer and building), only customers seated in a building get it (a clinic of his own keeps his
list), and on the plan he sees only that session's customers and ticks them himself.

- **Database** (`20261010180118_phoenix_crm_seating_session.sql`): `phoenix_crm_places.session`
  ('AM' | 'PM'), required where `shared_place_id` is set. The 9 places seated before it were all PM
  customers and were backfilled PM, so nothing moved. `phoenix_crm_insert_place` stores it (a caller
  that names none is seated in the customer's own list, so deploy and migration never have to be
  simultaneous), `phoenix_crm_save_plan` accepts an item whose `list_type` is its place's session,
  and `phoenix_crm_save_visit` files the visit under it.
- **One session per customer per day** needed no new rule: the plan's unique
  `(plan_id, plan_date, customer_id)` and `already_visited` already hold it.
- **Plan**: `effectiveListType` (suggestions.ts) puts a seated customer under his seating's session
  in the planner, `resolvePlanItems` checks the day and files the item by the chosen place's session,
  and the filter bar gains "Polyclinic or centre" (`plannerVenues`, `DoctorFilter.venue`).
- **Both migrations recreate `phoenix_crm_insert_place`**, so whichever is applied last used to erase the
  other's logic (production lost the one-timetable guard that way on 2026-10-10).
  `20261010190001_phoenix_crm_insert_place_session_and_one_timetable.sql` holds both, applied to staging
  and production and read back from `pg_proc`: session logic and `already_seated` present, execute
  granted to `service_role` only. Any later change to that function starts from THIS file's body.
- **Left as it was**: the review's grade-coverage tally still reads the customer's own list, because
  coverage is the customer's, not the session's.

## The one-timetable migration

`supabase/migrations/20261010190000_phoenix_crm_one_timetable_for_a_polyclinic.sql` — one file,
additive, rewriting no row's meaning. It adds `schedule_photo_path`, `schedule_photo_captured_at` and
`schedule_photo_by_hr_id` to `phoenix_crm_shared_places` with a unique index on the path; **backfills
each venue already seated in from its EARLIEST seating**, so a building whose doctors were registered
under the old rule keeps the first board that was photographed there; makes
`phoenix_crm_places_photo_uidx` partial; and recreates `phoenix_crm_insert_place` with the venue lock,
the `shared_place_not_found` / `_retired` / `_held` guards it already had, the new `already_seated`
refusal, reuse recognised by comparing the handed path against the stored one, and the SECURITY DEFINER
`revoke` / `grant` pair.

The recreated function's **base body is byte-identical to the live one** (md5
`514d1e77c9ea451f8e36da5781abc4c0` over the unchanged half) — the whole point of recreating rather than
patching is that the diff is only what this change adds.

| | staging `cifwmndunmlxjhyjugxa` | production `ozucdzovmcqvepbozvqf` |
| --- | --- | --- |
| three `schedule_photo_*` columns | present, read back live | present, read back live |
| `phoenix_crm_places_photo_uidx` | `WHERE (shared_place_id IS NULL)` | `WHERE (shared_place_id IS NULL)` |
| `phoenix_crm_shared_places_timetable_uidx` | created | created |
| `phoenix_crm_insert_place` | 6,220 chars, holds `already_seated` and `schedule_photo_path` | 6,220 chars, same |
| grantees | `{postgres,service_role}` | `{postgres,service_role}` |
| rows rewritten | none | none; 9 of 18 venues backfilled with their board (the 9 with a seating) |
| read again 2026-10-10, **before the apply** | — | 18 venues, 8 seated places, 0 `schedule%` columns, index still unconditional — the pre-apply state; the rows above are the after |

Applied to production by the owner on 2026-10-10 from his own terminal through `scripts/apply-sql-file.mjs` (pooler `aws-1`), after `apply_migration` was declined by the MCP server four times over the `drop index` and `revoke` lines and the script was refused for Claude by the auto-mode classifier. Read back from `pg_class` / `pg_proc`, not the ledger: 9 venues with a seating, 9 venues now holding their board.

## Moving a standalone customer into a polyclinic — the Super Admin, 2026-10-10

Reps registered doctors as separate customers before polyclinics existed. Each carries his own
door photo and point while he actually sits in a building the rep has since validated, so the list
shows four clinics where there is one, every visit is measured against a point that is not the door,
and the three-a-day cap on the building cannot see them.

His words, 2026-10-10: *"only the super admin can move a customer in one list … to a polyclinic … add
the option to the admin to move this doctor to — and the validated polyclinics of the rep I am
standing in his account appears. And I move the doctors to the polyclinic."* On the doctor's place:
*"since he is in the polyclinic, he's already in the polyclinic. His only place is mismatched. So he's
supposed that his location be exactly matching with the polyclinic I'm moving him to."* So the place
adopts the venue's point, brick and area exactly, and nothing is offered to choose. On the way back he
chose "Yes, back to To validate" (the Place checks board's existing reject already does it — a seated
place is an ordinary active row). On a polyclinic with no timetable photo: *"you will count the visit
normally … but it will not be included in KPIs until the timetable of the doctor in the polyclinic is
updated … we validate the polyclinic normally as we validate anything, and we validate the customer
inside the polyclinic by the timetable."* He chose one screen, tick several customers, one written reason.

| Piece | Where |
| --- | --- |
| The move | `phoenix_crm_seat_places_in_venue(p)` — one statement sets `shared_place_id`, `photo_path` (the building's board, else his own photo kept) and `point_source = 'shared_place'`, copies point, brick and area, and nulls `pin_*`, `photo_*` and the three `moved_*` fields (the `phoenix_crm_places_moved` check forces that). One `place_seated` event per place, its `before` holding the old photo path |
| Who | `seatPlacesInVenue` in `server/place-move.ts`, gated on `canDecideSharedPlaces` — the Super Admin alone, never the SFE Manager. The route is `POST /api/phoenix-crm/list/places/seat`, permission `update` |
| The screen | `seat-in-venue-screen.tsx`, opened from the customer page ("Move into a polyclinic") |
| The KPI hold-out | a customer seated where no timetable is on file goes back to `pending` with `validated_at = null`; every KPI already reads `customer_validated`, so nothing in the KPI code changed. He can still be planned, sent and visited |
| The timetable arriving later | `phoenix_crm_set_venue_timetable` and `phoenix_crm_settle_venue_timetable`, reached by the rep's "Photograph the timetable" screen: a pending `match` is validated, `other_name` / `no_schedule` stay held, an approved review is never undone |

🔴 **`unjudged` never holds**, here as everywhere (owner, 2026-10-08): when the timetable read could not
judge (no key, unreadable, call failed) the customer stays validated. Only a building with no board
at all, or a board read as another name or no schedule, holds him.

A seated pending customer is not offered "Validate this customer" — capturing his own door again
would undo the move. He sees "Waiting for this building's timetable" instead.

Applied 2026-10-10 to staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`, through
`scripts/apply-sql-file.mjs` with `PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com`); read back
from `pg_proc` on both: three SECURITY DEFINER functions, grantees `{postgres,service_role}`, no row rewritten.
A rolled-back seating on staging found a live constraint the plan had missed —
`phoenix_crm_places_seated_has_session` (`shared_place_id IS NULL OR session IS NOT NULL`) — so a seated
place carries its customer's AM or PM list as `session`, and a pharmacy (neither) is refused as
`pharmacy_cannot_be_seated` and never offered on the screen.

Consequence, stated not fixed: plans already sent are not re-checked against the three-a-day cap; the
cap bites on the next save, the next send and at the door.

## Verification still owed after the merge

Production has no point-in-time recovery — seven daily backups are the whole recovery story — and this
migration rewrote nothing, so there is nothing to restore from. What remains is the ordinary
post-merge check: `/api/healthz` `revision` must carry the merge commit before any of this is called
deployed, and the rep-side walk-through (capture a venue, seat three customers, confirm the fourth
visit of a day is refused at the door and the fourth planned call is refused on save and on send)
belongs on a dev server with dev-auth headers, not on a green CI run.

## The picker was EMPTY on every phone — the envelope read twice, 2026-10-12

The rule is one line in `.claude/rules/phoenix-crm.md`. This is what it cost.

**The defect.** `crmGet(url, key)` ends in `return body[key] as T` — the hook's answer IS the value,
never the envelope. All three screens that read `/api/phoenix-crm/shared-places` typed it
`useCrmGet<{ sharedPlaces: SharedPlaceChoice[] }>(…, "sharedPlaces")` and then read
`data?.sharedPlaces`: a property an array has never carried. `undefined`, `?? []`, and **the venue
picker was empty on every phone from the moment the feature shipped (#5670)**. Because the generic is
an *assertion* and not a check, neither `tsc` nor typescript-eslint could see it, and the screen then
renders "No polyclinic or centre is on this territory yet" — which reads exactly like a territory that
has none.

**Why it only became fatal on 2026-10-10.** #5743 (merged 18:34) added the `!chosen` gate on the
timetable camera and #5745 added the AM/PM step. Both are rendered only once a venue resolves out of
that empty list, while `seatedDraftProblem` still returns `SEATED_PLACE_NO_SESSION`. So from 18:34
that evening the save was unreachable: **the last successful seating anywhere in the company was
2026-10-10 16:35:52**, against 55 venues of which only 9 carry a timetable — all 9 photographed
before 18:34 that same day.

**What it did to one rep.** B-161, Sherif Medhat, Medical Representative, seat `SEAT-AIF-REP-CA4`
(Anti-Infective / Cairo East 2 / brick المرج):

| Cairo time, 2026-10-12 | `phoenix_crm_touch_trail` |
| --- | --- |
| 15:24:51 | picks "In a polyclinic or centre" → "No polyclinic or centre is on this territory yet", with 8 of his own buildings in the table |
| 15:25:16 | "Save this building" — مستشفى الكرمه stored |
| 15:30:56 – 15:31:41 | **nine taps on "Save the customer"**, each answered by `div[role=alert]` "Choose whether this customer receives in the AM…" — a question not drawn on his screen |
| 15:31:14, 15:31:48 | the empty-territory line again |
| 15:34:39 | photographs the same building a fourth time, believing each save had been lost |

He ended with **12 venue rows and 0 seated places**. Every photo slot ever issued to him became a
venue signboard photo; not one became a timetable.

**What the evidence could and could not say.** The touch trail named it. Ruled out first, each with a
live read: all 26 `SHARED_PLACE_COLUMNS` exist in production (no 42703); 12 rows match
`loadSharedPlacesFor`'s exact filter; `territory()` resolves his seat (the POST, through the same
gate, wrote those rows); `read` is granted (`/api/phoenix-crm/list` → 200 in 2,235 ms); no 500 in
`app_error_events`. 🔴 **The HTTP log carries no identity and the read answered 200 — a 200 on the
list proves nothing about what the screen did with it.** And `railway logs --http --since <N>m`
silently returns only the last ~1 minute whatever N is: it showed zero `shared-places` requests in a
window that provably contained four. Do not trust it for a past window.

**The fix.** Three call sites now `useCrmGet<SharedPlaceChoice[]>(…)`, read as `venues.data ?? []`
and `venues.data?.find(…)`. `tests/phoenix-crm-shared-place.test.ts` sweeps **every** `useCrmGet` in
`src/components/phoenix-crm` (comments stripped, `hooksChecked >= 30`) and refuses a generic that
wraps the key the hook has already unwrapped. Broken and watched: reintroducing the wrap in
`venue-timetable-screen.tsx` → exit 1, "venue-timetable-screen.tsx: useCrmGet already unwraps the
envelope"; restored → exit 0.

**Left for the owner, not done here.** Those 12 rows of his are 11 duplicates — 7 × الراهبات plus
السلام (الراهبات) from 2026-10-10 22:49–23:14, and 4 × مستشفى الكرمه / الكرمه التخصصي from
2026-10-12 14:36:37, 15:25:16, 15:30:46 and 15:34:39 — all `active`, all with `schedule_photo_path`
NULL. They will every one appear in his picker once this ships. Retiring the extras is a bulk
production data change and waits for his word.

## A held venue can be chosen — owner, 2026-10-14

A venue is **held** when its signboard photo did not confirm its own name (`other_name` or `no_name`,
`signboardHoldsForReview`). Until 2026-10-14 a held venue was greyed out in the rep's picker and
`phoenix_crm_insert_place` raised `shared_place_held`, and the rep's capture screen promised that the system
"confirms it automatically". **Nothing did**: the only release is the Super Admin's Approve on the shared-places
board. Measured on production that morning: 7 venues held, 0 ever decided, the oldest captured 13 Oct at 14:15
Cairo. A rep who had just captured a building could not seat one customer in it, and Save answered
"Choose the polyclinic or centre this customer receives in." because the screen also left a held building
unchosen.

His words: *"make him able to choose him even if the system is still checking"*.

| Piece | Now |
| --- | --- |
| The picker | A held venue is selectable and is chosen automatically right after the rep captures it. The rep's row shows only the customer count; the words "Not approved yet" are the Super Admin's board alone (golden rule #1: the rep is never made to feel checked) |
| `sharedPlaceForSeating` | Refuses a gone or removed venue only |
| `phoenix_crm_insert_place` | Migration `20261014151354` removes the `shared_place_held` raise; every other line is byte-identical to `20261010190001` (comment-stripped md5 `5ef27c3f9802e24f1ca94245847c38ad` read off production before the change, `6d9f6e9de8e145977e66166c1dfd1801` after) |
| Rejecting the venue | Unchanged and still the safety net: `phoenix_crm_decide_shared_place` retires every place seated in it and sends each customer back to To validate |
| The Super Admin's move | **Unchanged**: `phoenix_crm_seat_places_in_venue` still refuses a held venue, and its refusal now tells him to approve the venue first |

### Second half — customers in a held venue wait for its approval (owner, 2026-10-14)

His words: *"The visits are also pended, appearing, but they are not counted in KPIs until the admin confirm the polyclinic and the doctors in it."*

Every KPI reads `customer_validated`, so a customer left `pending` counts in no KPI but can still be planned and visited.

| Piece | Now |
| --- | --- |
| `phoenix_crm_validate_customer` | Reads the venue status under the seat's advisory lock. A seated customer in a held venue stays `pending` (event `customer_pending`, why `venue_held`) |
| `phoenix_crm_decide_shared_place` | **Approve** validates the pending customers seated in the venue (event why `shared_place_approved`) and returns `validated`. Reject is unchanged |
| `phoenix_crm_settle_venue_timetable` | A matching board releases a customer only when the venue is `active` |
| The customer's screen | A held building shows "Waiting for this polyclinic to be confirmed"; the "Photograph the timetable" button is hidden for it |
| The Saved screen | "Saved: name — the visits you save here show as pending, and they count in your KPIs once the polyclinic is confirmed" |

Migration `20261014200147`. On Approve a seated customer is confirmed except when the building has no timetable on file, its
timetable verdict is `other_name` or `no_schedule`, or a pending validation review exists for him (`unjudged` never holds).

Stated, not fixed:

- An `outside` customer from the "new" door is not validated at seating and still joins through his add request; if that
  request is approved while the venue is held he would become active (`decide_request` was not changed).
- `phoenix_crm_add_place` for an already-validated customer keeps his validation.
- The Super Admin's own move into a held venue still refuses it, and `phoenix_crm_set_venue_timetable` still refuses held venues.

Applied 2026-10-14 to staging and production through `apply_migration`; the three bodies were proven equal to production by
digest before editing, and read back after (`validate_customer` 32d1dd0f…, `decide_shared_place` 5798d729…,
`settle_venue_timetable` ade01082…; `prosecdef` true, grantees `{postgres,service_role}`). On production 9 venues are held
and the one customer seated in a held venue is `outside`, so nothing needed backfilling.

Applied 2026-10-14 to staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`) through
`apply_migration`; read back from `pg_proc` on both (`prosecdef` true, grantees `{postgres,service_role}`, digest equal
to the file). On production a transaction that always rolls back called the function against a real held venue and got
past the old refusal as far as the insert, then failed on the test row's own empty timings; nothing was written.

## Polyclinics on their own tab — owner, 2026-10-17

His words, in chat: *"in place checks separate the polyclinics/hospitals checks than normal clinic steps and make sure every polyclinic is grouped with the drs in it and showing the polyclinic itself photo validation and the drs timetable and make the option for the admin to reject a dr not in the time table"*.

**What the Place checks page did before.** A polyclinic was one section of the page, a flat table of buildings. The customers seated in it were scattered through the other sections among the single clinics — the held ones under "Waiting for your decision", the rest under "Validations the system did not question" — each showing "Seated in <building>" as a line of text, so nobody could read a building and the people behind its door together. The building's timetable photograph (`SharedPlaceRow.schedulePhotoPath`) was loaded and never drawn.

**What it does now.**

- Two tabs under the filter bar: **Clinics** (every set it had, minus the seated rows) and **Polyclinics and hospitals**. The shared filters apply to both, and each tab says how many rows it holds and how many of them are still open.
- On the Polyclinics tab each building is one block: the sign on its door and the timetable inside it, side by side, with the sign's own verdict, then the building's decision column, then **the customers seated in it** with what the timetable says about each (names them, names somebody else, no timetable in the photo, could not be read) and the hours read beside them.
- **Rejecting a customer who is not on the timetable** is one button on that customer's row, "Reject — not on the timetable". It opens already pointed at `schedule_other_name` ("The timetable does not name this customer"), or `schedule_missing` when the timetable read was "no timetable in the photo"; the reason list is the timetable's own (`reasonsFor("schedule")`), the note is optional, and the rejection is confirmed before it is sent. A customer the system is still checking also gets Approve; a rejected one that can be taken back gets "Approve it after all".

**There is no new decision path.** A customer with a review row is rejected through `POST /api/phoenix-crm/validation-reviews` (`decision: "reject"`, which works on a pending review and on an approved one and keeps the evidence); one the system never questioned goes through `POST /api/phoenix-crm/validation-reviews/refuse`, exactly as the single clinics' list does. The rep is told the one closed-list sentence about their photo and never that a person looked. Rejecting a customer retires their seat only — the building and everybody else seated in it are not touched; rejecting the building is still its own button and still retires them all.

**Where a row goes is decided by one test.** `withoutSeated` takes a row out of the Clinics view only when its `sharedPlaceId` is a building the board holds. The venue read keeps a rejected building for 90 days; a customer whose building has aged out of it, or whose place names a building that was never read, stays among the clinics where they can still be found. `ValidationReviewRow`, `ValidatedPlaceRow` and `ReopenedCustomerRow` now carry `sharedPlaceId` (the review read selects `shared_place_id` from the place row, which is why it is set whatever the hold was about).

**Two corrections that came with it.** (1) Customers seated in a **held** building count as waiting with it under the Waiting outcome: nobody behind a held building counts in any KPI until the building is approved. (2) `sharedPlacePassesOutcome` answered `false` for "Rejected" because a rejected venue was not read at all; since 2026-10-15 it is read for 90 days, so "Rejected" now shows exactly the retired ones and the board no longer hides the whole section under that outcome.

**A district manager's board** (`mode="team"`) draws the same groups and the same evidence and **none** of the decision controls: no Reject, no Approve, no sentence about who decides. Comments and recommendations hang off the seated customer's place as they do on the single clinics.

Pinned by `tests/phoenix-crm-shared-place-groups.test.ts` (the grouping, narrowing and outcome rules, and the source the board and the lists are wired from).

## Same place, several reps — owner, 2026-10-17

His words, in chat: *"I want you to make a third tab in the same page … a place validated by more than a rep. I want to put the three validations beside each other and show me insights and show me data to be able to know which one is the most accurate and which one is not. And of course, if a place you are in doubt of, you can make a fourth step asking, but not every place. What is clear and confident, put it direct. What is not clear and confident, in the fourth step, and I'm talking here about the admin only … that you doubt that those two or those three validations are for the same place."*

**What it is.** A third tab on Place checks, **Same place, several reps**, drawn only on the Super Admin's board (`mode="company"`). A district manager's board is handed no tab, no panel and no read, and the route refuses everyone but the Super Admin as well (`canDecideValidationReviews`). The data is read when the tab is **first opened**, not with the page — it pages through every validated place and polyclinic — and the board then stays mounted, so switching tabs does not read it again. The shared filter bar narrows it by rep, line, region, area, list and period; a place stays whole when **any** of its validations passes, so filtering on one rep still shows the others' readings beside theirs. The outcome selector means nothing here and is not read.

**What counts as a validation of a place.** A standalone place a rep validated (`phoenix_crm_places`, active, not test) or a polyclinic a rep captured (`phoenix_crm_shared_places`, active or held). A customer **seated** in a polyclinic is never a subject: they sit on the building's own point, so listing them would put every customer beside the building they are in and call it agreement. The building is the validation, and its seated count is shown on it. A group needs **two seats**: two places one rep validated in the same building are one rep's work, not a comparison.

**The anchor.** The photograph's fix (`photo_lat/lon`, with `photo_accuracy_meters`) — the shutter took it at the door, and a pin can be dragged — falling back to the stored point, then the pin. How far the rep's pin sits from their own photograph is shown as a trust signal ("Pin vs photo"), and more than 50 m is flagged as a moved pin.

**Three answers per pair, never two** (`place-match-groups.ts`, pure). With σ the hypotenuse of the two readings' accuracies (each held to 5–100 m, 25 when none was reported):

| Distance | Answer | What happens |
| --- | --- | --- |
| at most σ held to 30–60 m | same | grouped with no question |
| beyond 3σ held to 100–200 m | different | never shown |
| in between | unsure | put to the Super Admin — **unless both are places with different customer names** |

The last clause matters: two differently named customers 50 m apart are two doors far more often than one door read twice, and asking about all of them was 261 questions on the live data (almost all neighbours on one street); with the rule it is 29. **A name never settles a pair that has a polyclinic in it** (a building has no customer name) and never settles a pair a few metres apart.

**A group is tight, never a chain.** Joining every "same" pair let a street of customers 40 m apart run into one 24-reading "place" 220 m long. Closest pairs join first and a join is refused when it would make the group wider than 120 m. The Super Admin's own "same" answer is the one join that is never refused.

**Which one is most accurate.** For each member: the distance to the nearest validation by **another** rep; its own error (the phone's reported accuracy combined with the pin-versus-photo gap); and the likely error, the hypotenuse of the two. The best is named **only when it beats the next by a fifth** (`BEST_MARGIN` 0.8) — otherwise the card says *Too close to call*, which is an honest answer and is counted. Flags: *Far from every other rep* (needs **three** reps, at least 30 m, and twice the typical nearest distance — with two reps neither can be called the wrong one), *Weak GPS signal* (over 50 m), *Pin moved from the photo* (over 50 m), and the sign verdicts *names somebody else* / *names nobody*. The per-rep table gives each rep's median distance to the nearest other rep (smaller means the others bear them out), median reported accuracy, median pin gap, places they were clearly the most accurate on, places they were far off on, and signs that matched.

**The questions ("step 4").** Each one shows the readings on either side with their sign photographs, the closest distance, a hint when the same customer name sits on both sides, and two buttons: **Same place** / **Different places**. One answer covers every unsure pair that raised the question, so nothing is asked twice, and a bigger question is sent in pieces of at most 80 pairs (`MAX_ANSWER_PAIRS`). A place he confirmed carries *Take my answer back*; a pair he answered *different* is listed under "Answered as different places" with *Ask me again*. An answer about a validation that is gone is inert — nothing reads a pair whose subject is not on the board.

**Where an answer lives.** `phoenix_crm_place_match_answers` (migration `20261017160000`): one row per **ordered** pair (`subject_a < subject_b`), keys `place:<uuid>` or `venue:<uuid>` held by a CHECK and deliberately no foreign key, because a validation is either a place or a polyclinic and an answer about one that is later retired or merged away is inert. The unique index on `(subject_a, subject_b)` is **plain, not partial**: PostgREST's `on_conflict=` emits column names with no `WHERE`, and Postgres infers a partial index only when the predicate is repeated. RLS on, service role only. Nothing a rep receives reads it. Applied to staging and production on 2026-10-17.

**Measured on production on 2026-10-17 (read-only, the real loader with the real thresholds).** 159 places validated by two or more reps, 619 validations by 27 reps, 29 questions, a median spread of 21 m between a place's readings, 62 places too close to call and 11 with a far-off reading. The largest group holds 21 validations, which is why a place draws six and says "Show 15 more validations of this place". The read takes about 4–6 seconds, which is why it is lazy.

Pinned by `tests/phoenix-crm-place-match-groups.test.ts` (the pair rule and the name rule, the grouping, the diameter cap, the ranking, the outlier, the questions and answers, and the source the server, route, screen, board and migration are wired from).

## Same customer, several reps — owner, 2026-10-26

His words, in chat: *"go deep audit between reps validation and reconsiliciation of same drs in different reps and tell me what u got"*, and after the audit his pick **"Build the check"**.

**What it is.** A fourth tab on Place checks, **Same customer, several reps**, drawn only on the company board (`mode="company"`), for the deciders alone: the route refuses anyone `canReadPlaceMatches` rejects before a row is read. Like "Same place, several reps" it is read when the tab is first opened and then stays mounted, and the shared filter bar narrows it without splitting a card: a customer stays whole when any of its validations passes. It stores nothing — there is no answer table; the decider opens the validation in the review queue to act on it.

**Who is one customer** (`customer-match-groups.ts`, pure). Two validations by two different reps' seats, on the **same list** (a morning and an evening place of one person are never compared), whose names are the same person by `personNameWords` (a title is not part of the name, a compound like عبد الناصر is one word written either way, the order of words is the name, one word is never a name, and a leading prefix counts only from three words up — a two-word name matches only whole, because it opens far too many other names). Two **known, different** specialities are two people; an unknown speciality never separates two names.

**When a pair is listed** — the photograph's own fix is the reading trusted (`matchAnchorOf`), the Place checks' own rule:

| Shape | When |
| --- | --- |
| One area, places far apart | both name the same area and the anchored points sit more than 1 km apart (`SAME_AREA_FAR_METERS`) |
| A pin on another rep's point | one rep's pin sits within 50 m of the other rep's point (`PIN_ON_OTHER_METERS`) while that rep's own photograph was taken more than 150 m from the pin (`PIN_FAR_FROM_PHOTO_METERS`) — listed whatever the area; with no photograph there is nothing to say where the rep stood, so it is not listed |

Two areas far apart are two clinics and are never listed on distance alone.

**The card.** One card per customer, with every validation of that name — the agreeing ones included — grouped by the point it sits at (within 150 m, `AGREE_METERS`): validations that agree share a point number, and the one that stands alone is last. A card gathers a same-name validation only when it is in the same area or within 150 m of a listed reading, so a namesake in another governorate never joins (found on the live data: a card had pulled in a namesake 124 km away in Beni Suef). Each card says, in neutral words, where each reading sits and how far apart — never a verdict on a rep.

**Measured on production on 2026-10-26 (read-only, the real rule on 3,414 active places; the board builds in 30 ms).** 15 customers listed — 12 "one area, far apart" and 3 "a pin on another rep's point" — covering 33 validations by 14 reps. The three pins sat 24 m, 13 m and 31 m from the other rep's validation while their own photographs were 869 m, 441 m and 257 m away.

Pinned by `tests/phoenix-crm-customer-match-groups.test.ts` (the name rule, the speciality rule, the list rule, both shapes, the namesake, the card's grouping and order, the neutral sentence, and the source the loader, route, screen and tab are wired from).

## The timetable scanner, and Place checks as a report — owner, 2026-10-17

His words, in chat: *"their is a disatster in the polyclicnics validation a fucken chaos no timetables employees photgraphing their legs"*, *"i must be be able to see chose photos"*, then *"eyeball the check places full module all tabs and telll me is this a report that really show me data? or its a bunch of chaos … put corrective actions even if we will neeed to rebuild the module from sctach"*, and *"and whatb about the unreadble photos'"*. His rulings, picked from the options put to him: *"3 tries then held to confirmation by admin"*; *"save but hold to me and tell the rep that the dr name is not in the timetable so hheld for admin approval"*; scanner and screen rebuild in ONE PR; *"every polyclicnic should crystal clear show me the name opf the polyclicnic and its data and the customer the repo added to this -poly clicnic and the captured timetable crystal clear … make me able to rotate the picture of validation in place checks bec some timetables are rotated"*; and, later the same afternoon, *"add system recommendations to approve or no on every vlidation"* and *"and the reason of system recommendation"*.

### What was wrong, measured on production that morning

- **0 of 70** customers seated in polyclinics passed the timetable check: 45 judged unreadable, 22 showing no timetable, 3 naming somebody else. An unreadable timetable was `unjudged`, and `unjudged` was accepted as if it matched — so every one of the 45 went through.
- An eyeballed sample of 18 photographs: all 9 "no timetable" were a street, a pavement, a corridor floor, a door or a building sign; about 7 of the 9 "unreadable" were REAL timetables the reader failed on. Two separate failures — reps photographing the wrong thing, and the reader failing on real boards.
- 15 photographs carried 48 seatings, and 3 of them came back with contradicting verdicts, because the same board was sent to the model once per customer.
- The Place checks page drew everything it held: the Clinics tab was 104,455 px tall ("Decided in the last 14 days" alone was 197 rows, 88,288 px and 789 buttons) and the Polyclinics tab drew all 98 buildings, test and rejected ones among the live.

### The door — a scanner, three tries, then a hold

`scheduleDoorAction(check, earlierTries)` (`schedule-rules.ts`) decides, before anything is written:

| What the reader saw | Answer |
| --- | --- |
| The customer's name on the board | save |
| A board read clearly, without the name | save, **held** — the rep is told the customer's name is not on the timetable, so it is held for admin approval |
| No timetable in the photo, or one that cannot be read, on try 1 or 2 | **refused**: what to fix, and "Try 2 of 3" — nothing saved |
| The same on the third try | save, **held** — the rep is told it could not be read (or no timetable was found) after 3 tries, so it is held for admin approval |
| A lost call, no key, no photo bytes | save, as before — never refused, never held (the key has run dry silently twice) |

"Not on it" is said only of a board the reader could see all of; a board read in part is a photograph to retake. Tries are counted **per rep, per building, per Cairo day** in `phoenix_crm_refused_readings` (reasons `timetable_unreadable` / `timetable_missing`, the building in `shared_place_id`, migration `20261017193000`, applied to staging and production on 2026-10-17): the timetable belongs to the building, and a new customer has no id to count against. A refusal is filed before it is raised. The refusal travels as `phoenix_crm_photo_timetable_retake` (`SCHEDULE_RETAKE_CODE`), which the rep's web screen already reads as "back to the photo step"; when the board on file was reused, the camera opens to photograph it again, and a readable new photo replaces the building's board. The exact sentences live in `SCHEDULE_HELD_TEXT` and the retake text beside it — never a second copy.

The reader (`server/schedule-check.ts`) now returns how legible the board is (`clear` / `partial` / `unreadable`) and what is wrong with the photograph (`not_a_timetable`, `too_far`, `blurred`, `glare`, `cut_off`), runs with `maxRetries: 0` so its 8-second budget is real, and **judges a reused board against the reading already stored** when that reading could see it — one photograph, one reading.

**This is his named exception to golden rule #1.** The rep is told, in so many words, that a seating is held for admin approval. Everything else he is told stays what is wrong with the photograph.

### The last try may be an upload — owner, 2026-11-02

His words: *"make after 2 failed live capture try the third i am able to upload and when upload the same location and timestamp as capture also are put"*. Asked what a file naming the customer should do, he chose **"Validate it"** over holding it; asked which photos, he chose **the timetable only**, so a signboard and a visit stay camera-only.

| Point | What it does |
| --- | --- |
| When it opens | Two refused photos of this building, this rep, this Cairo day, on the server's count. `loadSharedPlacesFor` tells the phone (`timetableRefusedToday`), so a rep returning later the same day still sees it; a refusal re-reads the count. A body that claims an upload sooner is refused and sent back to the camera (`SCHEDULE_UPLOAD_TOO_EARLY`). |
| The stamp | The same helpers as a capture: the time now, the place read now, the sharper of the running reading and a fresh one, a cold reading overruled. **It says when and where the file was uploaded, not when the picture was taken.** No reading, no photo. |
| Where the stamp goes | **Under the picture, never over it** (`uploadedPhotoCanvasSize`). The reader crops 18% to 49% off the bottom of a stored photo; on a file that would cut away the names at its foot on the last try. |
| What the door does | The same ruling as the third live try: the name read saves and validates; a clear board without the name holds; unreadable or no timetable holds. |
| Two things it does not do | A file nobody read (a lost call, no key, no bytes) is **held**, where a live photo saves: a live photo at least proves the rep stood at the wall. A picture of a phone or computer screen is still held, under his 2026-10-28 ruling. |
| Who is told | `uploaded: true` on `schedule_check` and the review row, carried to every customer judged against that stored reading. The recommendation on Place checks says it in one sentence; only the deciders read that. A held building still keeps its customers out of KPIs until it is approved. |

The standalone timetable door (`venue-timetable-screen.tsx`) runs no scanner tries, so it has nothing to open and stays camera-only.

### Choosing the model — calibrated on the 40 production photographs, read-only

The 40 distinct photographs behind the 74 production seatings were replayed through the door's own question (`readScheduleBytes`): `gpt-5.4-nano` read about 5; `gpt-5.4-mini` read 17, at a p95 of 6.2 s, inside the 8-second door. `gpt-5.4-mini` was the door's model until 2026-10-19 (see the next section; it is now the fallback). At 900 output tokens the stronger readers ran out of room on exactly the photographs that are real boards (a 25-name directory), so the ceiling is 1,600 and the transcription is kept short. Replayed through `scheduleDoorAction` as first tries, the 74 seatings would have been 11 save, 2 hold, 1 lost call (saved), 28 retake for no timetable and 32 retake for an unreadable one.

### Claude reads the timetable first — 2026-10-19, measured on the 54 production photographs

**Why it changed.** The OpenAI account ran out of credit on 18 Oct. The reader asked OpenAI first, so a door read paid a refused OpenAI round trip (about 1.5 s) and Claude then got only what was left of the 8 seconds. With no Claude model named, `gpt-5.4-mini` mapped to Haiku. On 19 Oct at 11:34 Cairo that read timed out after 6.5 s, and the customer was saved with his building's timetable unread (a lost call saves, by rule). Nothing reads that timetable again. The same happened on 17 Oct at 22:17, when `gpt-5.4-mini` itself timed out.

**What it does now.** `readScheduleBytes` asks Claude first, by name (`preferProvider: "anthropic"`, `PHOENIX_CRM_SCHEDULE_CLAUDE_MODEL`), with the whole 8 seconds. `gpt-5.4-mini` is asked only when Claude's account is dead. The signboard door reads with the same model.

**The measurement (read-only).** The 54 distinct production timetable photos were replayed through `readScheduleBytes`, the door's own question and crop, with 30 seconds to answer so the real time shows:

| | Claude Haiku | Claude Sonnet |
| --- | --- | --- |
| Median | 4.6 s | 3.5 s |
| 95th percentile | 8.7 s | 5.5 s |
| Over the 8-second door | 5 | 1 |
| Over the 6.5 s a dead OpenAI left | 12 | 2 |
| Photos where the seated customer's name was read | 12 | 17 |
| Seatings matched | 18 of 93 | 25 of 102 |

Haiku also lost 2 photos to a failed download, which is why its seat count is lower. On these boards the stronger model is also the faster one, so nothing is traded. Then 10 photos went through the default path with nothing forced, on the real 8-second budget: all 10 were read, in 2.7–5.2 s, and no OpenAI call came first. Pinned by `tests/phoenix-crm-timetable-scanner.test.ts`, section 4.

### The 74 seatings re-read, 2026-10-17 16:44 Cairo

Announced before it ran. Every production seating's timetable was read again with the scanner's reader — each distinct photograph once, every customer judged against that one reading — writing **only** `phoenix_crm_places.schedule_check`. No status, hold or review row was touched; the pre-image of all 74 records was saved first; every written row was read back.

| | Before | After |
| --- | --- | --- |
| Names the customer | 0 | 9 |
| No timetable in the photo | 22 | 29 |
| Could not be read | 47 | 33 |
| Names somebody else | 4 | 3 |
| Lost call | 1 | 0 |

74 written (63 active, 11 retired), 0 failed, 0 differing on read-back, 24 verdicts changed. Legibility: 11 clear, 36 partial, 27 unreadable. The 65 that still do not pass are exactly what the screen below is for.

### Place checks, rebuilt as a report

`validation-reviews-board.tsx`, built from the rows the page already loads — no new read.

- **Each rep's captures on one line** at the top (`place-check-scorecard.ts`, pure): places, confirmed, not readable, no sign or timetable, another name, not read yet, waiting, sent back, and "timetable names them x of y". Every place sits in exactly one column, so a line adds up to its own Places figure. Worst share first, ten shown, then the rest; tapping a name narrows every tab through the board's own Rep filter.
- **Five tabs:** *Needs you* (on a manager's board, *Being checked*) — the clinics waiting and the buildings with anything open, with one line saying what the system recommends across them; *Not confirmed* — places in use the reader never confirmed and nobody looked at, narrowed by chips (not readable, no sign in the photo, another name, never read, every place in use); *Polyclinics and hospitals* — problem buildings first, a rejected building behind its own switch; *Same place, several reps* (unchanged, Super Admin only); *History* — decided in the last 14 days, and who waits to be captured again.
- **Only the open tab is drawn, every list is paged** (20 rows, 10 buildings), and **no test entry is drawn** anywhere. The stat cards count what the board draws: no test entry, and no rejected building among the polyclinics.
- **Every building is one card:** its name large, its kind and where it stands, who captured it and when, its address, brick and area; then the sign on its door and the timetable inside, side by side and large, with what was read on the timetable; then the customers seated in it. A building with customers and no timetable says so in rose.
- **Every photograph on Place checks turns a quarter at a time** (↺ ↻ on the photo and in the full-screen view, `photo-rotation.ts`). The frame swaps its sides so a turned photo still fits; the stored photograph is never changed; and only Place checks passes `rotatable`, so a rep's screens are exactly as they were.
- **Every validation carries the system's recommendation and its reason** (`place-check-advice.ts`): approve, reject or look yourself, with the one sentence of evidence behind it. A confident reading opens Reject already on its reason; an unreadable photo never pre-picks one. It decides nothing — the answer is still his press, one row or ticked together — and a district manager's board never draws it.

Pinned by `tests/phoenix-crm-timetable-scanner.test.ts`, `tests/phoenix-crm-place-check-scorecard.test.ts`, `tests/phoenix-crm-place-check-advice.test.ts`, `tests/photo-rotation.test.ts` and `tests/phoenix-crm-shared-place-groups.test.ts`.

### A count opens its photographs — owner, 2026-10-17, the evening it went live

Looking at the live page that evening, the owner said: *"don't put for me non-readable … make me see what is the unreadable. The photos, I must be able to see the photos."* Two things stood between him and them:

- **A count went nowhere.** "9 not readable" next to a rep was a number. Now every count except Places and Confirmed is a button. `placeOfTarget` on the board decides where it leads:
  - it sets that rep (every rep from the total line) and clears the outcome selector, since the scorecard never reads that selector and its counts would not match otherwise;
  - a photo problem or a sign never read opens its own chip on Not confirmed;
  - a place waiting opens Needs you;
  - a customer sent back opens History;
  - the timetable count opens Polyclinics and hospitals.
- **Seated customers on Not confirmed.** The scorecard counts customers seated in a polyclinic, but Not confirmed lists single clinics. When a tapped count holds seated customers, a line above the list names how many and opens Polyclinics and hospitals. Their photo is the building's one timetable, so it is shown once on the building's card, never repeated per customer.
- **The photo was the smallest thing on the row.** On Not confirmed the photograph was a 128-pixel square in a 12% column, beside a refusal form that stood open on every row. Now:
  - on both Not confirmed and Needs you, the photo is the widest column (36% and 30%), 20rem tall and shown whole;
  - on a phone, the photo spans the whole card;
  - the reason list, the note and the cost appear only after "Refuse this validation" is pressed.

Measured on production that evening before the change: Needs you 9,965 px, Not confirmed 14,083 px, Polyclinics 12,741 px and History 14,521 px tall. There was no sideways scroll at a 2,124 px window, no rounded corner, no broken photo and no test entry on any tab.

## A polyclinic with no timetable — owner, 2026-10-18

City clinic (Giza, captured by the Pedia seat of Hadeer Abdelnaser) is the polyclinic itself and has no timetable on its wall. Six customers were seated in it — Ahmed Abdelazim, Sherif El-Segini, Mohamed El-Ghandour, Radwa Shama, Ahmed Samir Abdelsalam and Ahmed Nasr — and every one had been rejected, because a polyclinic's customers are validated by the building's timetable and there was none.

His ruling, in his words: *"the city clinic is the polyclinic itself … this polyclinic does not have a timetable. So you will make the place verified, and make those doctors validated by the admin as an exception for this polyclinic and show this."*

**What was done to the data (production, in the session):**

- The building is approved by the administrator on the strength of its door sign, which matches; its note says it has no timetable and its customers are validated by him as an exception.
- All six customers are active, validated, seated in City clinic, with an approved review whose note says the same. Their stale "validate again" bells were withdrawn, and four visits were measured again against the seat. The rep was told nothing.
- A settle never undoes an approved review, so a later read of the board does not reject them again.

**What the screen shows (this change):** two columns on `phoenix_crm_shared_places`, `timetable_exempt_at` and `timetable_exempt_by_hr_id` (set together or not at all), set on City clinic by the administrator.

- The building's "timetable inside" frame is replaced by "This building has no timetable. Its customers are validated by the administrator as an exception", with who set it and when, instead of the rose "No timetable on file, and 6 customers are seated here" — and the door photo on file is not drawn as a timetable. The header carries a "No timetable" pill.
- Each customer's cell reads "This building has no timetable" and, once approved, "Validated by the administrator as an exception"; the system's recommendation is silent on an approved customer and is "look" on one still waiting (`adviseOnTimetable(timetable, true)`), never a rejection and never a pre-picked timetable reason.
- "Reject — not on the timetable" is not offered there, since its refusal would tell the rep something false about his photograph.
- The building is not sorted up as a problem (`venueHasProblem`).
- 🔴 A manager's board states that the building has no timetable and never who decided it.

**What it is NOT.** The columns are a marker for the screen. Nothing in the database or the settle reads them to validate anybody, so a customer seated in City clinic later is still held, and the administrator's Approve on him is the exception. Declaring another building without a timetable is a deliberate act on that one row; there is no screen for it yet.

Pinned by `tests/phoenix-crm-shared-place-groups.test.ts` and `tests/phoenix-crm-place-check-advice.test.ts`.

## Seating is refused away from the building — owner, 3 Nov 2026

This amends his 2026-10-09 "no location when a customer is seated". The point on the row is still the building's, and nothing he seats stores a reading of its own.

**What happened.** Khaled Bedair rejected عيادات الحصرى ١٢ (29.9561373, 30.9076283) on 29 Oct, 12:35 Cairo, "No Table". At 15:09:54 on 3 Nov, Hadeer Abdelnaser Osman Hassan seated Dr Farid Shawky in the look-alike عيادات الحصري at Hossary Station (29.9732, 30.9437), 3.9 km away, and replaced that building's timetable with a photo. A seating asked for no location, so nothing could see it. The far-visit rule then refused seven visits at the real door between 15:11:11 and 15:12:52, at 3,919 to 3,970 m. The wrong tap is an inference; nothing suggests cheating. Asked the same afternoon, over the 14 days before: 419 far refusals, 60 on seated places, 11 customers and 6 reps; the wrong-building cause is proven only for this one.

**His two answers, 3 Nov, about 15:3x Cairo.** "Move him (Recommended)" and "Refuse at seating (Recommended)".

**What was done to the data (production).**

- 15:36:40 Cairo, in his name, in one transaction: place `072e73f4` moved to his old point with `point_source = 'moved'` and a written reason on the `place_moved` event, status active, still listed under building `412fb041` so it counts toward its three a day. Address and brick were copied from the old place row. Hadeer's last reading is 13 m from it.
- Two visits (14 and 21 Oct) re-pointed to that place, flag ok, 37 m and 11 m unchanged.
- عيادات الحصري's `schedule_photo_path` restored to `…/2026/10/place/9971defa-….jpg`, captured 2026-10-18 08:23:21 UTC by Hadeer. The before-image was `4d5dc663`, captured 2026-11-03 13:09:24 UTC; **this restore wrote no event row, so this paragraph is its record.** That photo stays on Dr Farid's own place row as evidence.

**The rule.**

- Save reads the location in silence (`useSilentFix`, watching only on the building door) and sends `standingAt`. The rep adds no step and is shown nothing.
- `seatingAwayFromBuilding` is `visitAwayFromValidatedPlace` against the building's two door readings and `visit_far_meters`, never a second distance rule, so a rep the seating lets through can log the visit there.
- Both doors, `validateCustomer` and `addPlace`, ask right after the venue is read and before the timetable scan, so a refusal spends no try and replaces no board.
- The refusal goes back to the building step and clears any fresh photo, which is stamped with the refused building's name and would otherwise replace another building's board.
- It is filed in `phoenix_crm_refused_readings` as `far_from_place`, `subject_kind` place, with the metres and `shared_place_id` (`20261103154101` widened that CHECK). Timetable tries are counted by their own two reasons, so it can never spend one.

**Decided by the build, not asked.**

- **No reading seats as before.** Location off, no reading within eight seconds, an older build, or one wider than the visit's 500 m is not measured and never a refusal. A rep with location off can therefore still seat in the wrong building; his visits there are still refused, as they were.
- **A manager validating beside the rep, and the Super Admin's move, are not asked,** as a manager's own visit is not.

**Expected.** Over the 30 days before: 427 seatings, 315 with a visit reading within 20 minutes; 299 of those (95%) within 300 m, median 34 m; 16 beyond it (10 at 300 to 1,000 m, 6 over 1 km). That reading can be up to 20 minutes from the seating, so it is a rough proxy. Pinned by `tests/phoenix-crm-seat-at-building.test.ts`.


## The validation audit — 14 Nov 2026

The owner asked for a deep audit of how a doctor and a polyclinic are validated, and for every finding to be closed. Each finding below was checked against production rows that morning (read-only), then fixed in one change. Pinned by `tests/phoenix-crm-validation-audit-timetable.test.ts`, `-door.test.ts`, `-reviews.test.ts`, `-sql.test.ts` and `-decisions.test.ts`.

### The building's timetable

- **"Photograph the timetable" read the photo after storing it.** A picture of a wall replaced a good board, every customer behind it was read again as "no timetable", and the settle sent the whole building out of the KPIs with nobody told. The seating door had refused that same picture since 17 Oct. The photo is now read first, and a confident "no timetable here" with nothing transcribed is refused in the retake words (`venueTimetableRefusal`). Everything else is stored as before: a board nobody could read, a timetable on a screen (his 28 Oct "Save it"), a reader that never answered. No try is counted, because nothing is seated here to hold.
- **A saved board, or a saved move, could answer an error.** The settle after the commit threw; the rep's retry was then refused as a photo already used, and the Super Admin's move was refused as "already in a building" with its visits never measured again. Both settles are now caught and logged.
- **A seating saved on a lost call was never read again.** The door's rule stands (no key, a lost call or no bytes never refuses and never holds). The night now reads that photograph again, up to three nights (`runLostTimetableRereads`, after the signboard pass). Found live: two customers of 21 Oct in مجمع السلام الطبي, validated on a board nobody had read. The pass walks its backlog page by page, each page starting after the last row of the one before: the backlog also keeps rows the night can never read (a building exempt from a timetable or with no board yet, a name too short to match, three re-reads spent), and a single first page would have been those same rows every night once they filled it. Its limit of 200 counts places it will read, never rows it walked past. Measured the same day: 5 rows in the backlog, 1 of them in an exempt building, so nothing had been stuck.
  - 🔴 **It only writes the verdict on the place's own row.** No settle, no review, no notice. A customer the board does not name shows on Place checks for a person to decide.
  - `unreadable` is an answer and is never read again by the night. A building with no board, a building declared to have no timetable, a retired building and a name too short to match are skipped.
  - A lost call is asked about the photograph the door asked about; a row nobody has read is read against the building's board, as the building's own settle reads it. 179 of 537 seated places carry their own photograph rather than the building's board, so the two are not the same thing.

### The door and the signboard retake

- **The building's board on file cost the rep a try.** A reused board read as unreadable was filed like one of his own photographs, so he stood at "Try 2 of 3" before opening the camera. It is still refused with the retake words, but not filed and not counted.
- **One photograph sent twice was counted twice.** Seven rep, building and day groups, of 387 refusals. The same photo of the same building by the same rep on the same day is now filed once.
- **The signboard retake printed the rep's own distance in metres.** It is one fixed sentence now (`SIGNBOARD_RETAKE_AWAY_FROM_PLACE`). The Google refusal still names "within 150 m": that is the rule the reps were sent on 3 Oct, pinned by `tests/phoenix-crm-google-place-check.test.ts`.
- **A retaken photo inherited the old photo's read count,** so a held place whose reads were spent was never read again. A new photo starts its own count (`signboardRetakeCheckToKeep`).
- **The retake filed an integrity flag on one reading.** The stored photo is now read a second time after the reply, and the flag is filed only when the two agree (`signboardAfterSecondReading`).

### Reviews and notices

- **"Validate again" stayed in the bell after the customer was validated.** Only the door and the take-back of one rejection withdrew it. It is now withdrawn wherever a customer ends validated: an approval on Place checks (`decideValidationReview`, `approveValidatedPlace`), an approved building, a building brought back, and a validation shared from another line (`withdrawValidateAgainNoticeQuietly`). Found live: 105 bells on 96 customers validated after the bell.
- **A review left pending on a retired place held the customer for ever.** Rejecting a building, or retiring a place, retires the place and leaves its review pending. The rep's row then read "checking" with no way out and his requests waited on Place checks. A pending review counts only while its place is active (`activePlaceIds`), in `loadLocationChecks`, `pendingLocationReview` and `pendingLocationReviewCustomers`. Latent: none of the 49 pending reviews that morning sat on a place that was not active.
- **His latest answer is the row decided last, not the row created last.** A place has one review row for all time, so refusing a place approved weeks ago decides an old row today, and a newer approval of another place hid the refusal. `decidedLater` is the one comparison, used by the rep's list and by the reopened list.
- **A second refusal of the same place reached nobody.** It raised its notice on the first refusal's key, and a key that already reached him is never delivered twice. The refusal's instant now rides on the end of the key (`attempt`); the prefix a withdrawal clears by is unchanged.
- **A reopened customer was shown under the wrong refusal.** A customer whose own place was refused once, and whose building was refused later, showed the old reason, rep and date. Both refusals are read and the later one is shown.
- **The waiting reviews shared one ceiling with every decision ever made.** The wide read cut the oldest rows first, which is where a review still waiting sits. Waiting rows are read on their own (ceiling 50,000); only decided rows meet the 5,000 ceiling.
- **Refusing a validated place threw away what it was once held on.** The row's `google` record was replaced whole. The earlier record is kept under `before`, one level deep (`evidenceToKeep`). Every reader reads the top level, so nothing on a screen changes.
- **The system's own approval asked nothing about a short name.** It now asks the same three-names gate the two deciders' button asks, and leaves the review waiting when the gate refuses (`heldReviewNeedsFullName`).
- **A rejected or restored building left its visits unmeasured.** Refusing one place measures the customer's visits again; refusing or bringing back a whole building did not. Both now do, after the reply (`restampSeatedCustomersQuietly`). A restored building also shares each validation across the lines of the area, as one restored place does.

### The database — `20261114050048_phoenix_crm_validation_audit_fixes.sql`

Four functions replaced, each from the body production held that morning. No table, column, constraint, index or grant changed, and the file writes no row.

- `phoenix_crm_validate_customer`: its two `location_in_review` refusals count a pending review only while that review's place is active. Without this, the door refused the very capture it had just asked for.
- `phoenix_crm_validate_customer`, `phoenix_crm_decide_validation_review`, `phoenix_crm_place_on_trusted_point`: validating a customer clears `reopened_at`. The stamp of an old refusal used to come back, with its age, the next time he was sent to To validate by a path that stamps nothing.
- `phoenix_crm_place_on_trusted_point`: it withdraws a drop request still open on the customer it validates, as the review's approval does, and upper-cases the actor as its siblings do.
- `phoenix_crm_insert_place`: a seated place is written with no pin of its own. The building's point used to be copied into the pin columns, where it read as a second reading taken at that customer's place.

### The owner's four decisions, 14 Nov 2026 — `20261114051314_phoenix_crm_validation_owner_decisions.sql`

Asked as four questions that morning, about 05:10 Cairo. Pinned by `tests/phoenix-crm-validation-audit-decisions.test.ts`.

- **"Stop and say why."** "Approve it after all" is refused, by name, when the customer was dropped (`restore_customer_dropped`), when the place sits in a retired building (`restore_building_retired`), or when the customer already has another active place at the same door, meaning the same building or within 150 m (`restore_door_captured_again`). Each has its own sentence in `server/db.ts`. Before this, 15 of 57 take-backs left a customer with two active places at one door, and one left an active seat in a retired building.
- **"Stay in on his clinic."** A customer a building's board does not name is no longer sent out of the KPIs when he stands validated on another place: an active place of his own, or a seat in an active building that its board names or a person approved, with no decision waiting on it (`phoenix_crm_customer_stands_on_another_place`). The settle returns him under `kept` and writes nothing on him. The Super Admin's move into a building with no board follows the same rule. No live case that morning.
- **"Record only."** The night's re-read of a timetable the door lost writes its verdict on the place's own row and nothing else. See "The building's timetable" above.
- **The three clean-ups** he chose are recorded below.

### How the two files reached the databases

Both files were applied to staging with `scripts/apply-sql-file.mjs`. 🔴 **Production took them earlier than planned.** A rehearsal meant to roll back ran the files inside its own transaction, and the first file's own `commit;` committed it. Nothing was lost by it: the eight functions were read back the same morning and are the same on staging, on production and in the two files (md5 of `pg_proc.prosrc`, recorded in `ACKNOWLEDGED_EXCEPTIONS`), and each is executable by postgres and the service role only. The behaviour was then proved on production inside a transaction that did roll back, 19 checks of 19, with 0 rehearsal rows kept. Staging held 0 validation reviews and 0 buildings that day, so it could not rehearse these functions. A rehearsal script must never be handed a file that carries its own `commit`.

### What was done to the data (production, 14 Nov 2026)

On his three answers. Each row was copied first into `phoenix_crm_backup_20261114` (anon and authenticated revoked), and the copy was counted before anything ran: 105 notice states, 1 review, 15 pairs, 30 places, 100 visits, 5 plan lines.

- **105 "Validate again" bells archived,** on 96 customers validated after the bell was raised. All 105 had been read, and none had a review waiting. After: 0 standing on a validated customer; the 264 on customers still to validate were not touched.
- **One review corrected.** فادى عاصم الشفاء at مستشفى الشفاء التخصصي still read "rejected" from 18 Oct, though the owner seated him there on 8 Nov. It is "approved", dated to that seating, with a note and a `validation_review_approved` event that carries what it was. After: 0 rejected reviews on an active place of a validated customer.
- **15 same-door twins merged,** found through the `place_restored` events whose reason is `validation_restored`. The older place was retired through `phoenix_crm_update_place` in his name, the newer one kept, and the older one's 30 visits moved to it through `phoenix_crm_restamp_visit_locations`. 5 plan lines followed. No visit was judged again: 0 flags changed (29 ok, 1 far before and after), and 10 distances changed, by 76 m at most, because 4 of the pairs stood 2 to 84 m apart. After: each of the 15 customers is validated with exactly one active place.

### Left as it is

- "Approve a review while its building is held" is not built. It needs the building's release changed in the same file (`phoenix_crm_decide_shared_place` and `phoenix_crm_restore_shared_place`); 3 of the 9 reviews pending that morning in a held building would otherwise be left pending with nothing to decide.
- `reopened_at` is still not cleared by `phoenix_crm_decide_shared_place`, `phoenix_crm_share_line_validation`, `phoenix_crm_decide_request` and `phoenix_crm_reverse_list_request`. 237 active customers keep an old stamp; no reader shows it while they are validated.
- The "any pending review" test is unchanged in `loadTwinWorld`, `countValidationReviewsWaiting`, `phoenix_crm_place_on_trusted_point`, `phoenix_crm_decide_shared_place` and `phoenix_crm_restore_shared_place`.
- The seated places that already carry a copied pin keep it (no backfill).
- One seat stands in a retired building: حضانه احمد محروس, validated, 3 visits. Reported to the owner, not changed.
- The Google refusal still names "within 150 m", and a retake on a short-named customer raises no "waiting for you" notice.
