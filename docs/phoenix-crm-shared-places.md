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

His seven decisions, each asked and answered in chat the same day:

1. **A shared place is a venue only** — on nobody's list, takes no visit, counts in no call rate and
   in no KPI. The seated customer stays the one who is planned, visited and counted.
2. **The cap is three visits a day inside one shared place**, whatever the number seated there, and it
   bites **both** when he plans the day and at the door.
3. **Scope is every shared venue** — polyclinic, medical centre, medical tower, hospital outpatient —
   carried as a `kind` on the record. The polyclinic is the first case, not the only one.
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

## Why the timetable photo is per customer and not one shared image

Two measured reasons, not a preference:

- `phoenix_crm_places_photo_uidx` is **UNIQUE on `photo_path`**, so one image pointed at three places
  cannot be stored at all.
- The camera **burns the evidence stamp with that customer's name** into each capture, and the schedule
  read crops that band off (`stampBandFraction`, the same arithmetic `drawStamp` writes with) before
  the model reads the timetable. One shared image would lose the per-customer evidence and the crop
  would have nothing to do.

## Why a seated customer is an ordinary place row

Everything downstream already works off a place: the visit's distance check, `placesFor` and the
re-measure, the plan item's optional `place_id`, the move and retire audit, `brick_*` / `area_*` /
`region_*`. A seated customer therefore gets a normal `phoenix_crm_places` row with `shared_place_id`
set, the venue's point copied, `point_source = 'shared_place'`, `photo_path` the timetable and
`schedule_check` its read. **Nothing else in the module has to learn a new shape** — and because the
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

## Verification still owed after the merge

Production has no point-in-time recovery — seven daily backups are the whole recovery story — and this
migration rewrote nothing, so there is nothing to restore from. What remains is the ordinary
post-merge check: `/api/healthz` `revision` must carry the merge commit before any of this is called
deployed, and the rep-side walk-through (capture a venue, seat three customers, confirm the fourth
visit of a day is refused at the door and the fourth planned call is refused on save and on send)
belongs on a dev server with dev-auth headers, not on a green CI run.
