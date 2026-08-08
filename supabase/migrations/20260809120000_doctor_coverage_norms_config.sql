-- Doctor Coverage — admin-editable visit norms, per contact KIND and grade.
--
-- Until now the norm was a TypeScript constant: DOCTOR_COVERAGE_TARGETS = { A: 2, B: 1, C: 1 },
-- applied to every contact on the board. That rule was written for doctors, but the iReports360
-- `speciality` column also carries pharmacies, hospitals, contracts and health-insurance offices —
-- measured on production 2026-08-08, 2,363 institutions and 260 commercial accounts, together 21%
-- of the graded panel. All of them were being told to expect 2 visits a month like an A-grade
-- physician, and were marked red when they did not get them.
--
-- Owner directive 2026-08-09: "MAKE FOR ME AN OPTION IN ADMIN PANEL TO CHANGE NUMBER OF VISITS
-- /MONTH/GRADE". So the norm becomes data, editable per kind (sp = doctor, hcp = pharmacy /
-- hospital / contract / insurance) and per grade (A / B / C).
--
-- ZERO MEANS NOT SCORED, not "needs zero visits". A target of 0 would otherwise make every
-- contact of that kind trivially green (visits >= 0 is always true) and silently inflate the
-- coverage %. Instead the domain drops those contacts from the panel and the denominator
-- entirely, which is the honest reading of "we do not hold this population to a frequency".
--
-- Safety:
--   * Purely additive; nothing existing is altered.
--   * Idempotent (create table if not exists, insert on conflict do nothing).
--   * Service-role only: RLS enabled with NO policies, matching probation_config and the rest of
--     the admin-config singletons. The domain layer reads/writes via getSupabaseAdmin().
--   * Defaults reproduce TODAY'S behaviour exactly (2/1/1 for both kinds), so applying this
--     migration changes no number on any board until the owner edits the values.

begin;

create table if not exists public.doctor_coverage_config (
  -- Singleton, same shape as probation_config / v2_vacation_sla_settings.
  id boolean primary key default true check (id),
  -- { "sp": { "A": 2, "B": 1, "C": 1 }, "hcp": { "A": 2, "B": 1, "C": 1 } }
  norms jsonb not null default '{"sp":{"A":2,"B":1,"C":1},"hcp":{"A":2,"B":1,"C":1}}'::jsonb,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.doctor_coverage_config enable row level security;

-- Seed the singleton so the admin editor has a row to update. Defaults = current behaviour.
insert into public.doctor_coverage_config (id) values (true) on conflict (id) do nothing;

comment on table public.doctor_coverage_config is
  'Singleton: Doctor Coverage visit norms per contact kind (sp/hcp) and grade (A/B/C). 0 = that population is not scored and leaves the coverage denominator. Service-role only.';

notify pgrst, 'reload schema';

commit;
