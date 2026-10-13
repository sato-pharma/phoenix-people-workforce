-- refused_readings_blocked_permission
--
-- WHAT THIS CHANGES:
--   phoenix_crm_refused_readings.reason accepts a fourth value, 'blocked', beside 'no_fix', 'rough'
--   and 'off_listing', and the table gains one nullable column, blocked_permission, which names
--   which permission the BROWSER refused — 'location' or 'camera'. A second CHECK pairs the two:
--   blocked_permission is filled exactly when reason is 'blocked', and null for every other reason.
--   No index, no policy, no grant and no row is touched.
--
-- WHY:
--   The three reasons already here are all SERVER refusals: the phone sent a reading and the server
--   turned it away. A permission the BROWSER itself blocks never reaches the server at all, so it
--   reaches no board either — the rep sees the message, the capture ends on her screen, and the only
--   trace anywhere is the touch trail, and only if she presses the message.
--
--   What that cost, on 2026-10-13: Norhan Gamal could not validate on her iPhone (iOS 18.7,
--   Safari 26.6.1) on 10 and 12 October. Her phone answered PERMISSION_DENIED within ~5 s of each
--   press — twice on 12 October at 10:59:01 and 11:10:15 Cairo, three times on 10 October — and
--   `phoenix_crm_refused_readings` held ZERO rows for her seat, because nothing was ever sent.
--   Finding her took a forensic dig through the touch trail, which across 4-12 October held 42
--   location and 30 camera refusal messages from four different reps, every one of them invisible to
--   the refused-readings board. The rep is still told nothing new (Golden Rule #1, owner 2026-09-26):
--   the message on her screen is unchanged, and this row exists only so the Super Admin can see that
--   her phone, not the server, is what refused her.
--
-- ROLLBACK:
--   delete from public.phoenix_crm_refused_readings where reason = 'blocked';
--   alter table public.phoenix_crm_refused_readings
--     drop constraint if exists phoenix_crm_refused_readings_blocked_permission_check;
--   alter table public.phoenix_crm_refused_readings
--     drop constraint phoenix_crm_refused_readings_reason_check;
--   alter table public.phoenix_crm_refused_readings
--     add constraint phoenix_crm_refused_readings_reason_check
--     check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text]));
--   alter table public.phoenix_crm_refused_readings drop column blocked_permission;
--   Additive in full: it widens one CHECK, adds one nullable column and adds one CHECK over it.
--   Dropping the column loses only the browser refusals recorded since it was applied.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This writes no rows and deletes nothing.

begin;
set local lock_timeout = '5s';

alter table public.phoenix_crm_refused_readings
  add column if not exists blocked_permission text;

comment on column public.phoenix_crm_refused_readings.blocked_permission is
  'Which permission the BROWSER blocked, for reason = ''blocked'' only: ''location'' or ''camera''. Null for every server refusal. See src/lib/phoenix-crm/refused-readings-rules.ts.';

alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_reason_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_reason_check
  check (reason = any (array['no_fix'::text, 'rough'::text, 'off_listing'::text, 'blocked'::text]));

-- The pairing, stated once here rather than trusted to four call sites: a 'blocked' row without the
-- permission it names is unreadable on the board, and any other reason carrying one is a writer bug.
alter table public.phoenix_crm_refused_readings
  drop constraint if exists phoenix_crm_refused_readings_blocked_permission_check;

alter table public.phoenix_crm_refused_readings
  add constraint phoenix_crm_refused_readings_blocked_permission_check
  check (
    case
      -- `is not null` FIRST and explicitly: a bare `= any (...)` against a null evaluates to NULL,
      -- and a CHECK refuses only FALSE — so without it a 'blocked' row with no permission named is
      -- accepted. Measured on staging 2026-10-13, before this line existed: it inserted cleanly.
      when reason = 'blocked' then blocked_permission is not null
        and blocked_permission = any (array['location'::text, 'camera'::text])
      else blocked_permission is null
    end
  );

notify pgrst, 'reload schema';

commit;
