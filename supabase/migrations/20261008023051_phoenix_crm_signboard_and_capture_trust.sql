-- phoenix_crm_signboard_and_capture_trust
--
-- WHAT THIS CHANGES:
--   1. phoenix_crm_places gains `signboard_check jsonb` — what the system read on the signboard in
--      this place's own photo, or why it could not read it. Null only on a row written before today.
--   2. A partial index on the rows the nightly sweep still has to read.
--   3. phoenix_crm_places gains `brick_lookup` — whether anybody actually looked for this place's
--      brick, which the row has never been able to say.
--   4. phoenix_crm_location_integrity's `source` CHECK widens from ('gps','photo','behaviour') to
--      include 'capture_trust' and 'signboard'. Nothing else about that table: `source` is part of its
--      UNIQUE (subject_kind, subject_id, source), so a new value SITS BESIDE the existing verdicts
--      instead of replacing one. Its subject_kind CHECK already allows 'place'.
--   No function, no policy, no grant, and not one existing row rewritten except the two backfills.
--
-- WHY:
--   The module validated a LOCATION while the owner graded an IDENTIFICATION. Of the 643 places
--   validated in the five days from 03 Oct 2026, 233 photos were good, 231 weak and 179 failed —
--   street shots with no building in them, blank walls, a photograph of a paper timetable, a photo
--   taken from inside a moving car — and 561 of the 643 (87%) got no identity check of any kind,
--   because the only one that existed, the Google listing comparison, covers AM accounts alone
--   (googleCheckApplies). The accuracy gate was working the whole time; nothing ever asked the
--   photograph to show whose doorway it is.
--
--   Owner's ruling, 2026-10-08: require the customer's name always, no exception; frame the signboard
--   in the camera; read the captured picture before accepting it; then validate or send it for review.
--   `signboard_check` is where that reading is kept, for EVERY place and not only the held ones, so
--   "how many validated places has the system actually read the sign of" is a query instead of 643
--   photographs eyeballed by hand. It also carries the sweep's backlog predicate.
--
--   `source` is the second half, and it closes a gap nobody had looked at. A place stores TWO
--   independent GPS readings — the photo's own shutter fix and the separate Capture location pin — and
--   NOTHING has ever compared them with each other. Each was checked against its own 250 m ceiling and
--   that was all, so three live active places sit with their photo and their pin 869 m, 1,553 m and
--   687 m apart, both readings individually "precise" and the gap unmeasured. assessCaptureTrust in
--   src/lib/evidence/capture-trust.ts already answers exactly this and three other modules already
--   consume it; Phoenix CRM simply never called it. It files a FLAG and never a refusal or a hold: a
--   rep cannot pass a gap refusal by standing anywhere, because he does not choose which of his two
--   readings drifted.
--
--   `brick_lookup` makes explicit a distinction the place row could only ever make by accident. Null
--   brick columns have meant both "we looked and nothing is within BRICK_TRUST_KM" and
--   "loadBrickCentroids degraded to an empty list, so nobody looked", separated only incidentally by
--   whether brick_distance_km happens to be set. The outstation watermark makes that distinction in
--   words (unresolvedLookup: an approver must be able to tell "the pin is nowhere near a Phoenix brick"
--   from "we could not look") and the place row now does too. Measured today: all 18 brick-less active
--   places are 'none_nearby' at 3.2 to 7.5 km, and ZERO are 'could_not_look' — so this records a
--   brick-master coverage gap in El Mahalla El Kubra, the Banha outskirts, Basyoun, Ashmoun and Shibin
--   el Kom, and the third value exists so a future centroid-load failure is visible instead of looking
--   like open country.
--
-- ROLLBACK:
--   alter table public.phoenix_crm_places drop column if exists signboard_check;
--     -- DATA COST: every signboard verdict ever recorded is destroyed. There is no second copy for a
--     -- place that MATCHED; a HELD place keeps its evidence on phoenix_crm_validation_reviews.google.
--     -- Recoverable only by re-reading every photo through the nightly sweep, which costs one model
--     -- call per place.
--   drop index if exists phoenix_crm_places_signboard_unjudged_idx;
--   alter table public.phoenix_crm_places drop column if exists brick_lookup;
--     -- DATA COST: none that is not recomputable — every value is derivable from brick_id and
--     -- brick_distance_km exactly as the backfill below derives it.
--   delete from public.phoenix_crm_location_integrity where source in ('capture_trust', 'signboard');
--     -- DATA COST: every photo-vs-pin and signboard case the sweep has filed is destroyed. These are
--     -- recomputable from the places' own stored readings, so the loss is the sweep's time, not
--     -- evidence. This delete must run BEFORE the constraint is narrowed, or it cannot be re-added.
--   alter table public.phoenix_crm_location_integrity
--     drop constraint phoenix_crm_location_integrity_source,
--     add constraint phoenix_crm_location_integrity_source
--     check (source in ('gps', 'photo', 'behaviour'));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story. This adds
-- two nullable columns, one partial index and widens one CHECK; it backfills brick_lookup from columns
-- already on the row and touches nothing else.

begin;
set local lock_timeout = '5s';

-- 1 ─ What the system read on the signboard ─────────────────────────────────────────────────────

alter table public.phoenix_crm_places
  add column if not exists signboard_check jsonb;

comment on column public.phoenix_crm_places.signboard_check is
  'What the system read on this place''s signboard photo: {verdict, reason, signText, personNames, placeNames, nameScore, note, checkedAt, croppedFraction}. verdict "unjudged" means NO ANSWER WAS OBTAINED and NEVER that the photo passed. See src/lib/phoenix-crm/signboard-rules.ts.';

-- 2 ─ The sweep's backlog, and nothing else: a place already judged is never read twice ──────────

create index if not exists phoenix_crm_places_signboard_unjudged_idx
  on public.phoenix_crm_places (captured_at desc)
  where signboard_check is null or signboard_check ->> 'verdict' = 'unjudged';

-- 3 ─ Did anybody look for this place's brick? ──────────────────────────────────────────────────

alter table public.phoenix_crm_places
  add column if not exists brick_lookup text;

-- Backfilled from what the row already holds, which is the whole point: the distinction existed in
-- the data all along and could only be read by inference.
update public.phoenix_crm_places
set brick_lookup = case
      when brick_id is not null then 'matched'
      when brick_distance_km is not null then 'none_nearby'
      else 'could_not_look'
    end
where brick_lookup is null;

alter table public.phoenix_crm_places
  drop constraint if exists phoenix_crm_places_brick_lookup;
alter table public.phoenix_crm_places
  add constraint phoenix_crm_places_brick_lookup
  check (brick_lookup in ('matched', 'none_nearby', 'could_not_look'));

-- 🔴 The default is the UNKNOWN value, never 'matched': a row written by code that does not yet set
-- this must read as "nobody looked", so a missed write can never pass for a confident brick match.
alter table public.phoenix_crm_places
  alter column brick_lookup set default 'could_not_look';
alter table public.phoenix_crm_places
  alter column brick_lookup set not null;

comment on column public.phoenix_crm_places.brick_lookup is
  'Whether a brick was looked for when this place was saved: matched (one within BRICK_TRUST_KM), none_nearby (looked, nothing within it — read brick_distance_km for how far), could_not_look (the brick master could not be read). Set in resolvePlaceLocation, the one resolver a validation and a move share.';

-- 4 ─ Two more detectors may file evidence, beside the existing ones and never instead of them ───

alter table public.phoenix_crm_location_integrity
  drop constraint if exists phoenix_crm_location_integrity_source;
alter table public.phoenix_crm_location_integrity
  add constraint phoenix_crm_location_integrity_source
  check (source in ('gps', 'photo', 'behaviour', 'capture_trust', 'signboard'));

notify pgrst, 'reload schema';

commit;
