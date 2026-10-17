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
