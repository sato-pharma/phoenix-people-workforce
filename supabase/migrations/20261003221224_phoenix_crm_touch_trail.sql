-- ════════════════════════════════════════════════════════════════════════════════════════════════
--  Phoenix CRM — THE TOUCH TRAIL
--
--  Owner, 2026-10-03: "every click or every touch on the touch screen for this module to be saved in
--  a separate audit trail for Phoenix CRM. Every separate touch, every single thing is saved, even if
--  the rep didn't save it … anything you can record, anything you can capture … like a file manager
--  grabber. Anything touches him, automatically saved."
--
--  WHAT THIS IS FOR. Until tonight the module recorded only what a rep SUCCEEDED in saving. The two
--  incidents of 3 Oct — eighteen refusals one rep could not escape, then nine more in 67 seconds from
--  a second rep whose photo reading was frozen — were both reconstructed hours later out of upload
--  slots and storage bytes, because a refused attempt left nothing behind. `phoenix_crm_refused_readings`
--  (20261003211500) closed that for ONE door. This closes it for the whole module: the screen he
--  opened, the field he filled, the comment he typed and abandoned, the button he pressed that did
--  nothing. An attempt is now evidence whether or not it ended in a row.
--
--  🔴 GOLDEN RULE #1 IS NOT BENT BY THIS, AND MUST NOT BE. The rep's app is easy and it is BLIND: this
--  table adds no step to his day, draws nothing on his screen, changes no message and no figure, and
--  is readable ONLY above him — the same tier as the mock-location evidence, which is the Super
--  Admin's alone. A rep must never be able to tell this table exists.
--
--  🔴 IT IS UNKEYED AND IT IS MEANT TO BE. Nine identical presses are nine rows: the REPETITION is the
--  evidence. Any unique constraint here would collapse exactly the pattern that diagnosed both
--  incidents, and `phoenix_crm_refused_readings` was left unkeyed for the same reason.
--
--  🔴 `id` IS A bigint IDENTITY, NOT A uuid, BECAUSE OF THE VOLUME. A field day is hundreds of
--  interactions per rep; a uuid primary key would cost more in index than the rows it orders, and a
--  monotonic key is what lets a reader page this table by keyset instead of by offset — which it must,
--  since PostgREST stops at 1,000 rows with no error and no marker.
--
--  THE CAIRO DAY IS STATED, NEVER `current_date`. `visit_day` is the module's 02:00 business day
--  (phoenix_crm_save_visit's own rule), written by the caller from `cairoBusinessDay`, so an evening
--  of taps files on the day it was worked rather than on the server's UTC midnight.
--
--  ROLLBACK  begin;
--              drop table if exists public.phoenix_crm_touch_trail;
--            commit;
--
--            Nothing else is touched: this migration adds one table, four indexes and the four lock
--            statements, and alters nothing that already exists. Dropping the table restores the
--            database exactly as it was — the collector's own posts then fail and are swallowed,
--            which costs the trail and never a rep (see src/lib/phoenix-crm/server/touch-trail.ts).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

begin;
set local lock_timeout = '5s';

create table if not exists public.phoenix_crm_touch_trail (
  id bigint generated always as identity primary key,

  -- Whose hands. The signed-in person, which on a manager's entry-for-a-rep is the MANAGER: the trail
  -- answers who touched the glass, never who the work was about.
  actor_hr_id text not null,
  -- The territory the screen was serving, where the screen named one. Null on a screen that serves
  -- none (the module chooser), which is not a gap.
  seat_id text,

  -- One page load = one session_id, minted in the browser. It is what turns a heap of rows back into
  -- a sequence, and `ms_since_load` orders them inside it to the millisecond — finer than the
  -- timestamps can, because a batch of forty events shares one arrival.
  session_id text not null,
  ms_since_load integer,

  -- THREE CLOCKS, DELIBERATELY. `occurred_at` is the SERVER's, stamped on arrival and the only one
  -- nobody can set. `device_at` is the phone's own, kept because a disagreement between them is
  -- itself a finding (a wrong phone clock is how one visit got dated onto the wrong day). `visit_day`
  -- is the Cairo 02:00 business day the caller resolved.
  occurred_at timestamptz not null default now(),
  device_at timestamptz,
  visit_day date,

  -- WHAT HAPPENED. `kind` is the browser's own event name, narrowed to the set the collector sends
  -- (tap · press · type · change · focus · submit · screen · scroll · hide · show · offline · online).
  -- Free text on purpose: a kind this table has never seen must land, not be refused.
  kind text not null,

  -- WHERE. `route` is the pathname; `screen` the module screen that owns it; `element` a stable
  -- descriptor of the thing touched (tag plus its own test id, name or id); `element_label` the words
  -- a human would have read on it. All four are needed: a label alone cannot tell two identical
  -- buttons apart, and a selector alone is unreadable six months later.
  route text,
  screen text,
  element text,
  element_label text,

  -- WHAT WAS IN IT. `value` is the text the rep had typed at that moment, INCLUDING text he went on to
  -- delete — the abandoned comment is the single most valuable thing here and the owner asked for it by
  -- name. `value_length` is kept beside it so a long body can be reasoned about without reading it.
  -- 🔴 A PASSWORD-TYPE FIELD IS NEVER STORED AT ALL: the collector drops its value before the request
  -- is built, so no redaction here can be forgotten or undone.
  value text,
  value_length integer,

  -- WHERE ON THE GLASS, in CSS pixels within the viewport, for a pointer event that carries them.
  pointer_x integer,
  pointer_y integer,

  -- The viewport at the time, because "the button was off screen" is a real explanation for a press
  -- that never happened and cannot be recovered afterwards.
  viewport_w integer,
  viewport_h integer,

  -- The module's test world, on the same flag every other table here carries. 🔴 WHAT SEPARATES A
  -- MANAGER OR A SUPER ADMIN FROM A REP IS `actor_hr_id`, NOT THIS: the flag is set when the SESSION
  -- is a test persona (and a browser may only ADD it, never clear it), so a Super Admin working the
  -- real module files real rows under his own name — which is correct, and is why every read filters
  -- by actor rather than by this column.
  is_test boolean not null default false,

  created_at timestamptz not null default now()
);

-- One rep's own day, newest first: the read every investigation starts with.
create index if not exists phoenix_crm_touch_trail_actor_idx
  on public.phoenix_crm_touch_trail (actor_hr_id, occurred_at desc);

-- The whole field, newest first: "who is struggling right now".
create index if not exists phoenix_crm_touch_trail_recent_idx
  on public.phoenix_crm_touch_trail (occurred_at desc);

-- One page load replayed in order — the sequence that reconstructs what a rep actually did.
create index if not exists phoenix_crm_touch_trail_session_idx
  on public.phoenix_crm_touch_trail (session_id, ms_since_load);

-- A day's work for one territory, which is how a manager's question arrives.
create index if not exists phoenix_crm_touch_trail_day_idx
  on public.phoenix_crm_touch_trail (visit_day, seat_id);

-- The same four statements every table in this module states; `tests/phoenix-crm-boundary.test.ts`
-- holds each one of them to exactly these lines, so that no table is ever locked by accident.
alter table public.phoenix_crm_touch_trail enable row level security;
create policy phoenix_crm_touch_trail_service_role
  on public.phoenix_crm_touch_trail for all to service_role using (true) with check (true);
revoke all on table public.phoenix_crm_touch_trail from public, anon, authenticated;
grant all on table public.phoenix_crm_touch_trail to service_role;

comment on table public.phoenix_crm_touch_trail is
  'Phoenix CRM touch trail (owner, 2026-10-03): every interaction in the module, saved whether or not the rep saved anything. Service role only; readable above the rep alone (golden rule #1). Unkeyed on purpose — repetition is the evidence.';

notify pgrst, 'reload schema';

commit;
