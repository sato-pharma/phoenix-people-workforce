-- Remove the `sales_managers` distribution list, seeded speculatively in 20260911120000 and never
-- wired to anything.
--
-- A list that exists but drives nothing is what a later change mis-points at: it appears on
-- /admin/distribution-lists looking like an audience somebody chose, when nothing reads it. The
-- three live lists (closing_fixed_cc, hr_team, finance_team) each back a real sender.
--
-- Already applied to production 2026-09-11 after confirming nothing referenced it: no code path
-- names it, no company_email_aliases row pointed at it, it was never enabled, and `updated_by` was
-- null — so no decision of the owner's was discarded. This file exists so a rebuilt environment
-- reaches the same state rather than re-seeding a list production no longer has.
--
-- The original seed is deliberately NOT edited. An applied migration is a log entry, not a current
-- description of the schema; rewriting it would make the two environments' ledgers disagree about
-- what ever happened. The insert stands and this removes what it created.
begin;

delete from public.distribution_lists where list_key = 'sales_managers';

commit;
