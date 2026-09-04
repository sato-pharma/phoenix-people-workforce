-- The CV lifecycle, end to end, as one readable row per CV — and the bearer link that lets the
-- owner's live Google Sheet read it (owner request, 2026-09-04).
--
-- WHAT THE OWNER ASKED FOR, IN HIS WORDS: "the fully life cycle of the CV starting from the
-- candidate sending it to us" — confirmed received on Phoenix, confirmed received on Google Drive,
-- and when each of those happened. Today that answer is spread across four tables joined on two
-- different keys, one of which is not a foreign key, so nobody can ask it without writing SQL.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE ONE THING THIS VIEW CANNOT TELL YOU, STATED HERE SO NO READER ASSUMES IT CAN.
--
-- `arrived_at` is when META'S WEBHOOK REACHED PHOENIX, not when the candidate pressed send.
-- The WhatsApp Cloud API does send a per-message `timestamp`, but `ats_inbound_intake_queue.payload`
-- does not keep it: measured 2026-09-04, all 791 queued WhatsApp rows carry exactly 14 payload keys
-- and none of them is a timestamp. The webhook normally lands within seconds of the send, so this
-- is a good proxy and a bad promise — the column is named for what it is, and the sheet labels it
-- "Reached Phoenix", never "Sent". Capturing the real send time is a webhook change, not a view.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A VIEW RATHER THAN FOUR POSTGREST READS JOINED IN TYPESCRIPT.
--
-- Two of this repo's standing traps make the TypeScript version quietly wrong at exactly this size.
-- A PostgREST `.in()` carrying several hundred ids returns ZERO rows and no error, and an unbounded
-- `.select()` stops at 1000 with no marker — and there are already 979 CV files. Doing the join in
-- the database leaves one paged read with an explicit `.order()`, which is the shape that survives.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE QUEUE JOIN HAS TWO SHAPES, AND USING ONLY THE OBVIOUS ONE SILENTLY LOSES EVERY EMAIL.
--
-- `ats_cv_intake_events` and `ats_inbound_intake_queue` are written by different steps, neither
-- owns the other, and there is no foreign key between them — so the join is by identifier, and the
-- identifier is not the same thing on both channels:
--
--   whatsapp  queue.provider_message_id = event.provider_message_id   (both are Meta's wamid)
--   email     queue.provider_message_id = 'email:<mailbox>:<uidvalidity>:<uid>'
--             event.provider_message_id = the RFC Message-ID header, e.g. '<CANfd…@mail.gmail.com>'
--             …and the event keeps the pieces that DO match in its own columns:
--             event.mailbox_label + event.provider_uid.
--
-- Joining on provider_message_id alone therefore matches 730 of 733 WhatsApp CVs and 0 of 244
-- emails — measured 2026-09-04 — and 0 does not look like a bug, it looks like "email CVs have no
-- arrival time", which is exactly the kind of confident wrong answer this sheet exists to stop.
-- Splitting the queue's composite id lifts email to 67. The remaining 177 are messages the poller
-- ingested without leaving a matching queue row, which is why the whole join is LEFT and why the
-- view also exposes `intake_event_at` as the fallback the feed falls back to.
--
-- WHY THE FALLBACK IS SAFE TO SHOW AS "REACHED PHOENIX". Where both timestamps exist, the gap
-- between the queue row and the intake event averages 333 seconds on email (one poll cycle) and is
-- sub-second on the WhatsApp median. So the fallback is a few minutes late at worst, never early,
-- and the feed publishes a `timing_source` column so the reader can see which one they are looking
-- at rather than having to trust that they are the same.
--
-- READ-ONLY AND DERIVED. This view owns no data; every column comes from a table that is still the
-- source of truth. Dropping it loses nothing but the convenience.

begin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The lifecycle view
-- ─────────────────────────────────────────────────────────────────────────────

create or replace view public.ats_v_cv_lifecycle
with (security_invoker = on) as
with first_event as (
  -- One event per file. A file can be touched by more than one event (a retry re-runs the ingest),
  -- and the FIRST is the one that describes how the CV actually arrived; a later retry would report
  -- the same message a second time and inflate every daily count that reads this view.
  select distinct on (e.file_id)
    e.file_id,
    e.channel,
    e.provider_message_id,
    e.provider_uid,
    e.sender_display_name,
    e.sender_identifier,
    e.mailbox_label,
    e.source_channel_code,
    e.outcome,
    e.created_at as intake_event_at
  from public.ats_cv_intake_events e
  where e.file_id is not null
  order by e.file_id, e.created_at
),
queued as (
  -- The email id is composite; split it once here so the join below reads as a comparison rather
  -- than as string surgery. Parts are 'email' : mailbox : uidvalidity : uid.
  select
    q.channel,
    q.provider_message_id,
    q.created_at,
    q.claimed_at,
    q.finished_at,
    q.status,
    q.attempts,
    q.last_error,
    case when q.channel = 'email' then split_part(q.provider_message_id, ':', 2) end as email_mailbox,
    case when q.channel = 'email' then split_part(q.provider_message_id, ':', 4) end as email_uid
  from public.ats_inbound_intake_queue q
)
select
  f.id                                              as file_id,
  f.candidate_id,
  c.full_name                                       as candidate_name,
  coalesce(nullif(c.whatsapp, ''), c.phone)         as candidate_phone,
  c.status                                          as candidate_status,
  c.applied_for_job_title,

  -- HOW IT CAME IN. 'upload' is the honest label for a file with no intake event at all: somebody
  -- added it through the app by hand, which is a real route and not a gap in the data.
  coalesce(ev.channel, 'upload')                    as channel,
  ev.source_channel_code,
  ev.sender_display_name,
  ev.sender_identifier,
  ev.mailbox_label,
  ev.provider_message_id,
  ev.outcome                                        as intake_outcome,

  f.file_name,
  f.mime_type,
  f.size_bytes,

  -- STAGE 1 — reached Phoenix. See the warning above: this is the webhook, not the send.
  q.created_at                                      as arrived_at,
  -- STAGE 2 — a worker picked it up.
  q.claimed_at                                      as picked_up_at,
  -- STAGE 3 — the intake finished.
  q.finished_at                                     as intake_finished_at,
  q.status                                          as queue_status,
  q.attempts                                        as queue_attempts,
  q.last_error                                      as queue_last_error,
  ev.intake_event_at,

  -- The best available "Phoenix first saw this", and — always beside it — which of the two it came
  -- from, so a reader is never asked to assume the precision. 'queued' is the webhook/poll landing;
  -- 'processed' is the intake event, a few minutes later at worst; 'saved' is the file row itself,
  -- which is all that exists for a CV somebody uploaded by hand.
  coalesce(q.created_at, ev.intake_event_at, f.created_at) as reached_phoenix_at,
  case
    when q.created_at is not null      then 'queued'
    when ev.intake_event_at is not null then 'processed'
    else 'saved'
  end                                               as timing_source,

  -- STAGE 4 — saved in Phoenix. This is the row that proves the CV exists in the system at all,
  -- so it is the one column here that is never null.
  f.created_at                                      as saved_in_phoenix_at,

  -- STAGE 5 — saved in the owner's Google Drive. Null means not mirrored YET, which on a CV that
  -- arrived seconds ago is normal and on one from last week is a fault; `drive_error` separates
  -- the two without anyone reading a log.
  f.drive_mirror_at                                 as saved_in_drive_at,
  f.drive_mirror_path                               as drive_folder,
  f.drive_mirror_file_id                            as drive_file_id,
  f.drive_mirror_error                              as drive_error,

  -- STAGE 6 — the applicant answered, and the CV was filed out of "Not yet classified".
  c.preferences_declared_at,
  c.folder_filed_at,
  c.folder_kind,
  c.folder_key,
  c.preferred_region_code,
  c.preferred_area_name
from public.ats_files f
left join public.ats_candidates c on c.id = f.candidate_id
left join first_event ev on ev.file_id = f.id
left join queued q
  on q.channel = ev.channel
 and (
      (ev.channel = 'whatsapp' and q.provider_message_id = ev.provider_message_id)
   or (ev.channel = 'email'    and q.email_mailbox = ev.mailbox_label
                              and q.email_uid     = ev.provider_uid)
     )
where f.kind = 'cv';

comment on view public.ats_v_cv_lifecycle is
  'One row per CV file: how it arrived, when it reached Phoenix, when it was saved here, when it '
  'was mirrored into the owner''s Google Drive and into which folder, and whether the applicant '
  'later answered the classification questions. arrived_at is the WEBHOOK arrival, never the '
  'candidate''s own send time, which Phoenix does not store. Read-only and fully derived.';

-- Bearer-token readers reach this through the service role only. `security_invoker` makes the
-- view run with the CALLER's rights rather than the owner's, so these revokes are load-bearing
-- rather than decorative: without them the view would be a way around the base tables' own grants.
revoke all on public.ats_v_cv_lifecycle from anon;
revoke all on public.ats_v_cv_lifecycle from authenticated;
revoke all on public.ats_v_cv_lifecycle from public;
grant select on public.ats_v_cv_lifecycle to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The share links that feed the sheet
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A SEPARATE TABLE, for the same reason marketing did not reuse direct orders': a token here
-- unlocks candidate names, phone numbers and the folders their CVs sit in — personal data about
-- people who are not employees and never consented to a third audience. One revoke list per
-- audience is the only way a mistake in one report cannot widen another.
--
-- There is deliberately NO `allow_files` grant and no file surface. The two older sheets can stream
-- an evidence photo; this one links to Drive and to Phoenix, both of which ask the reader to be
-- logged in. A CV is the single most sensitive document this system holds, and a link that streams
-- one without authentication is not a feature anyone asked for.

create table if not exists public.ats_cv_lifecycle_share_links (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  -- 'feed' only, today. The column exists so a passcode-protected human page can be added later
  -- without a migration on a live table, exactly as the other two share tables are shaped.
  surface text not null default 'feed' check (surface in ('feed')),
  label text,
  created_by_hr_id text not null,
  created_at timestamptz not null default now(),
  -- MANDATORY. A link with no end date becomes an unowned copy of the candidate pool.
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_hr_id text,
  last_accessed_at timestamptz,
  access_count integer not null default 0
);

create index if not exists ats_cv_lifecycle_share_links_creator_idx
  on public.ats_cv_lifecycle_share_links (created_by_hr_id, created_at desc);

comment on table public.ats_cv_lifecycle_share_links is
  'Bearer tokens for the owner''s live CV-lifecycle Google Sheet. Mandatory expiry, one-click '
  'revoke, every read counted and stamped. Meant to sit inside a PRIVATE sheet''s Apps Script and '
  'never be handed to a person — the sheet''s own Google sharing is the real access control.';

-- RLS from the first day, unlike the two tables that had to learn this the hard way in
-- 20260806010000_share_links_rls_parity.sql: a bearer-token table created in `public` inherits the
-- schema-wide grants, and only RLS plus an explicit REVOKE keeps it shut.
alter table public.ats_cv_lifecycle_share_links enable row level security;

drop policy if exists ats_cv_lifecycle_share_links_service_role_all
  on public.ats_cv_lifecycle_share_links;
create policy ats_cv_lifecycle_share_links_service_role_all
  on public.ats_cv_lifecycle_share_links
  for all to service_role using (true) with check (true);

-- REVOKE FROM PUBLIC also strips what service_role held implicitly through the default ACL, so the
-- GRANT below is not optional. This repo has been bitten by exactly that before.
revoke all on table public.ats_cv_lifecycle_share_links from anon;
revoke all on table public.ats_cv_lifecycle_share_links from authenticated;
revoke all on table public.ats_cv_lifecycle_share_links from public;
grant all on table public.ats_cv_lifecycle_share_links to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Prove it, rather than report success and hope
-- ─────────────────────────────────────────────────────────────────────────────

do $verify$
declare
  v_view oid := to_regclass('public.ats_v_cv_lifecycle');
  v_tbl  oid := to_regclass('public.ats_cv_lifecycle_share_links');
begin
  if v_view is null then
    raise exception 'ats_v_cv_lifecycle was not created';
  end if;
  if v_tbl is null then
    raise exception 'ats_cv_lifecycle_share_links was not created';
  end if;

  if not (select relrowsecurity from pg_class where oid = v_tbl) then
    raise exception 'RLS is not enabled on ats_cv_lifecycle_share_links — bearer tokens would be unprotected';
  end if;

  if has_table_privilege('anon', v_tbl, 'SELECT')
     or has_table_privilege('authenticated', v_tbl, 'SELECT') then
    raise exception 'anon/authenticated can still read the share-link tokens';
  end if;

  if has_table_privilege('anon', v_view, 'SELECT')
     or has_table_privilege('authenticated', v_view, 'SELECT') then
    raise exception 'anon/authenticated can still read the CV lifecycle view — candidate phone numbers would be exposed';
  end if;

  if not has_table_privilege('service_role', v_view, 'SELECT') then
    raise exception 'service_role lost SELECT on the lifecycle view — the feed would break';
  end if;
  if not has_table_privilege('service_role', v_tbl, 'SELECT') then
    raise exception 'service_role lost SELECT on the share-link table — the feed would break';
  end if;
end
$verify$;

notify pgrst, 'reload schema';

commit;
