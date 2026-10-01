-- phoenix_crm_countable_visits_validated
--
-- WHAT THIS CHANGES:
--   phoenix_crm_countable_visits gains ONE column, customer_validated — true when the visit's own
--   customer has been validated and admitted to the rep's list (phoenix_crm_customers.validated_at
--   is not null). Nothing is added to the view's WHERE and no row leaves it.
--
-- WHY:
--   Owner, 2026-10-01: "the customer can be not validated normally and added to the plan normally,
--   also can normally log a visit with validation, but not counted in KPIs till validated."
--
--   The first two halves of that ruling have been true since 2026-09-22 and are pinned
--   (plan-rules.ts, tests/phoenix-crm-plan-never-blocked.test.ts): a customer carried over from
--   iReports360 and not validated yet is planned like any other, and a visit to him saves like any
--   other. The THIRD half — "not counted in KPIs till validated" — is the one with a hole in it, and
--   the hole is structural rather than anybody's slip.
--
--   `phoenix_crm_countable_visits` calls itself "the ONE predicate for does this visit count", and it
--   answers only ONE of the two halves of that question: the off-plan APPROVAL. The validation half
--   lives nowhere in the view — it is re-typed by hand as `join phoenix_crm_customers c on ... and
--   c.validated_at is not null` inside each of the four phoenix_crm_report_* functions, and the
--   view's own comment then says "every report joins the customer's validated_at" as though that
--   settles it. It does not: a reader that is a PostgREST `.from("phoenix_crm_countable_visits")` in
--   TypeScript has no join to forget, so it silently counts a visit to a customer nobody has
--   validated. Two of them do exactly that today, and both are things a manager reads as a rep's
--   work:
--     * the Team calendar's AM · PM · Pharmacies per rep per day (server/team-calendar.ts), which the
--       owner called the most important of the three reports;
--     * the exceptions board's AM/PM tallies over the rolling window (server/exceptions.ts), where an
--       inflated count hides a territory that has not worked.
--   So `phoenix_crm_report_visits_by_day` would print 0 for a day on which the Team calendar printed
--   3 — two screens disagreeing about one rep's Tuesday, with no way to tell which was lying.
--
--   The fix is a COLUMN and deliberately not a filter. A filter would make the view the whole
--   predicate, which reads tidier and breaks the rep's own screens: `loadMonthVisitCounts` feeds the
--   line "3 visits saved here, not counting yet" beside a customer he has not validated, and a view
--   that dropped those rows would turn that honest sentence into "No visits saved here yet" about
--   visits he really did make. With a column, each reader states which question it is asking, in one
--   visible `.eq("customer_validated", true)` — and the ones that must NOT filter say why.
--
-- WHAT IS NOT CHANGED:
--   * No row leaves the view, so every existing reader returns exactly what it returned before.
--   * The four phoenix_crm_report_* functions keep their own `validated_at is not null` joins. They
--     are correct, they are pinned by tests/phoenix-crm-countable-visits.test.ts, and replacing them
--     would be a rewrite of working SQL for tidiness.
--   * The anti-fraud path (phoenix_crm_location_integrity) still reads the raw table and judges every
--     capture, validated or not — a visit waiting on somebody is the one you most want judged.
--
-- ROLLBACK:
--   begin;
--   create or replace view public.phoenix_crm_countable_visits
--   with (security_invoker = true) as
--     select v.*
--     from public.phoenix_crm_visits v
--     left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
--     where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';
--   commit;
--   (A column can only be dropped from a view by recreating it, which the statement above does;
--   `create or replace view` cannot remove one. Nothing else in this file needs undoing.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- This one is neither: it adds a derived boolean to a view and reads no data.

begin;
set local lock_timeout = '5s';

-- The join to the customer is INNER, not left: phoenix_crm_visits.customer_id is `not null` and
-- carries a foreign key to phoenix_crm_customers, so every visit has exactly one customer row and no
-- visit can fall out of the view through it. A left join would read as caution and would quietly let
-- a `customer_validated` of null stand for "no customer", which cannot happen.
--
-- `v.*` expands to the base table's 46 columns in their own order — the same list the view already
-- carries — and `customer_validated` is appended after them, which is the one shape
-- `create or replace view` accepts for a new column.
create or replace view public.phoenix_crm_countable_visits
with (security_invoker = true) as
  select
    v.*,
    (c.validated_at is not null) as customer_validated
  from public.phoenix_crm_visits v
  join public.phoenix_crm_customers c on c.id = v.customer_id
  left join public.phoenix_crm_unplanned_visits u on u.visit_id = v.id
  where not v.is_unplanned or u.status = 'approved' or v.unplanned_kind = 'out_of_list';

comment on view public.phoenix_crm_countable_visits is
  'Visits that count in a KPI, and the second half of that question beside each one. A row is here '
  'when it was on a sent plan, or it is an off-plan visit the manager and the SFE have approved, or '
  'it is an out-of-list visit (which has no approval of its own). `customer_validated` is the other '
  'half: false until the visit''s customer is validated and admitted to the list, and a KPI counts '
  'only the rows where it is true. A rate or a tally therefore reads '
  'customer_validated = true; the rep''s own "visits saved here, not counting yet" deliberately does '
  'not, because it is counting what he saved rather than what counts. The anti-fraud path reads the '
  'raw table and judges everything.';

revoke all on table public.phoenix_crm_countable_visits from public, anon, authenticated;
grant select on table public.phoenix_crm_countable_visits to service_role;

commit;
