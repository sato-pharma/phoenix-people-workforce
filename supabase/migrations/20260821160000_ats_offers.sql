-- Recruitment — the offer table. The one thing the hiring half was missing.
--
-- The offer CHAIN already existed and was already live: workflow_registry_modules carries twelve
-- role-gated offer actions (app_select -> app_offer_prepare -> app_offer_submit_approval ->
-- app_offer_approved -> app_offer_generated -> app_offer_sent -> accepted/declined/expired), with
-- approval restricted to Super Admin so Talent Acquisition cannot approve its own offer. What did
-- not exist was anywhere to put the numbers, so every one of those stages was unreachable and no
-- application in production ever moved past offer_initiated. Seven applications, one interview,
-- zero offers, zero hires.
--
-- DELIBERATELY NOT A STATUS TABLE. ats_applications.stage is the offer's status and stays the only
-- one -- a second status column here would be a rival truth to keep in sync, and this repo has been
-- bitten by that shape before. This table holds the TERMS and the TRAIL: what was offered, who
-- prepared it, who approved it, when it went out, what the candidate said.
--
-- One row per application (unique). Re-preparing after a negotiation UPDATES the terms in place;
-- the superseded figures are preserved in ats_application_events, which is already append-only, so
-- no version column is needed to keep the history.
--
-- monthly_gross is the agreed figure as RECORDED BY THE RECRUITER. It does not feed payroll and no
-- salary derivation reads it -- src/lib/payroll/policy.ts stays the only place base/basic/net/gross
-- are derived. Converting a hire still goes through the normal HR flow, where the salary is entered
-- deliberately.

create table if not exists public.ats_offers (
  id uuid primary key default gen_random_uuid(),

  -- One offer per application. ON DELETE CASCADE matches every other ats_* child table: deleting
  -- an application already removes its events, interviews and file links.
  application_id uuid not null unique
    references public.ats_applications (id) on delete cascade,

  -- The terms. All three are required before the offer can be submitted for approval; the check is
  -- in src/lib/recruitment/offer-rules.ts so the UI can name what is missing rather than 400.
  job_title text,
  monthly_gross numeric(12, 2),
  start_date date,
  notes text,

  -- The trail. Each stamp is written by the action that also moves ats_applications.stage, so a
  -- stamp present with the matching stage is the proof the step actually ran.
  created_by_hr_id text,
  submitted_for_approval_at timestamptz,
  submitted_by_hr_id text,

  -- Approval is Super-Admin-only (enforced by the workflow registry, not by this table).
  approved_at timestamptz,
  approved_by_hr_id text,
  approval_rejected_at timestamptz,
  approval_rejection_reason text,

  sent_at timestamptz,
  sent_by_hr_id text,

  -- The candidate's answer. Free of the stage vocabulary on purpose: accepted | declined | expired.
  responded_at timestamptz,
  response text check (response is null or response in ('accepted', 'declined', 'expired')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The approval queue's read: "what is waiting on me". Partial, because approved and rejected rows
-- are the overwhelming majority once this is in use and none of them belong in that queue.
create index if not exists ats_offers_pending_approval_idx
  on public.ats_offers (submitted_for_approval_at desc)
  where approved_at is null and submitted_for_approval_at is not null;

alter table public.ats_offers enable row level security;

-- Same posture as every other recruitment table: service-role only, no anon/authenticated grant.
-- Visibility here is application-scoped -- the route asserts recruitment:read / recruitment:update
-- before it touches this table.
revoke all on table public.ats_offers from anon, authenticated;

grant select, insert, update, delete on table public.ats_offers to service_role;

drop policy if exists ats_offers_service_role on public.ats_offers;
create policy ats_offers_service_role
  on public.ats_offers
  for all
  to service_role
  using (true)
  with check (true);

comment on table public.ats_offers is
  'One offer per application: the agreed terms plus the who/when trail for prepare -> submit -> approve -> send -> respond. The STATUS lives in ats_applications.stage and only there. monthly_gross is a recorded figure for the offer letter -- it does not feed payroll.';

comment on column public.ats_offers.approved_at is
  'Set only by app_offer_approved, which the workflow registry restricts to Super Admin. markOfferSent refuses to send while this is null, which is what closes the registry own offer_initiated -> offer_sent shortcut: without that guard an offer could reach a candidate having never been approved.';

comment on column public.ats_offers.response is
  'The candidate answer: accepted | declined | expired. Recorded by whoever heard it -- nothing in this system emails the candidate or collects a reply.';

-- ats_applications.offer_id predates this table by months, was never populated (0 of 7 rows) and
-- points at nothing. Superseded by ats_offers.application_id, which is the single link; wiring both
-- directions would only create two pointers to keep in step.
comment on column public.ats_applications.offer_id is
  'DEAD -- never populated. Superseded by ats_offers.application_id. Do not wire this up.';
