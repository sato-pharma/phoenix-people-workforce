-- ─────────────────────────────────────────────────────────────────────────────
-- The browser roles can TRUNCATE six marketing config tables. RLS does not stop them.
--
-- ── WHAT IS ACTUALLY WRONG ───────────────────────────────────────────────────
--
-- Measured live in production 2026-08-13. Each of these six carries RLS ON with exactly ONE
-- policy — a permissive SELECT (`polcmd = 'r'`) for `authenticated` — and yet grants
-- INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER to BOTH `anon` and `authenticated`:
--
--   marketing_control_settings   marketing_distributors     marketing_products
--   marketing_request_types      marketing_review_routing   marketing_workflow_steps
--
-- For INSERT / UPDATE / DELETE the grant is inert: RLS is on, there is no policy for those
-- commands, and a command with no permissive policy is denied. Those are defence-in-depth debt —
-- they become live the moment anyone adds a write policy or disables RLS on one of these tables.
--
-- **TRUNCATE is different, and it is the reason this migration exists. RLS NEVER applies to
-- TRUNCATE.** No policy can stop it; the grant is the only control, and it is granted. This repo
-- has already learned that lesson once the hard way: `marketing_request_events` was built as an
-- append-only table with row triggers refusing UPDATE and DELETE, and `truncate` emptied it anyway
-- on staging, because TRUNCATE fires no row triggers and obeys no policy. Same mechanism here, one
-- layer lower.
--
-- ── MEASURED, NOT ASSUMED ────────────────────────────────────────────────────
--
-- Becoming the `anon` role on staging with the default grant restored, inside a rolled-back
-- transaction, and attempting the truncate on each table:
--
--   marketing_control_settings   0 inbound FKs   TRUNCATE SUCCEEDED   8 rows -> 0
--   marketing_review_routing     0 inbound FKs   TRUNCATE SUCCEEDED   3 rows -> 0
--   marketing_distributors       2 inbound FKs   refused (0A000, referenced by a foreign key)
--   marketing_products           1 inbound FK    refused (0A000)
--   marketing_request_types      1 inbound FK    refused (0A000)
--   marketing_workflow_steps     1 inbound FK    refused (0A000)
--
-- So only TWO of the six are actually emptiable, and the other four are saved by an inbound foreign
-- key rather than by any deliberate control — a protection that disappears the day someone drops
-- that FK. Note the audit item that prompted this named `marketing_request_types`, which turns out
-- to be one of the protected four; the real exposure is on two tables it never mentioned. That is
-- why this was measured per table instead of fixed from the ticket.
--
-- ── HONEST SEVERITY ──────────────────────────────────────────────────────────
--
-- This is defence in depth, NOT a remotely exploitable hole. PostgREST exposes no TRUNCATE verb, so
-- holding the public anon key is not enough to fire one; it needs something that genuinely runs as
-- `anon` or `authenticated` against Postgres directly — a direct connection, or a SECURITY INVOKER
-- function called on their behalf. The grants are simply wrong, cost nothing to remove, and their
-- presence is what would turn any future mistake into data loss.
--
-- ── WHERE IT CAME FROM ───────────────────────────────────────────────────────
--
-- Nobody wrote these grants. Supabase's default privileges hand every new table in `public` the
-- full set to anon/authenticated/service_role, so every table created without an explicit revoke
-- inherits this. That is why all six match exactly.
--
-- ── WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
--
-- Revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER from `anon` and `authenticated`
-- on the six tables. Nothing else.
--
-- SELECT is deliberately LEFT ALONE. Each table has a read policy that someone wrote on purpose,
-- and every reader in the application is server-side (service-role) — verified by search: no client
-- component references any of these six. Revoking SELECT would change an anonymous read from "empty
-- result" to "permission denied" for no security gain, because the policy already scopes reads to
-- `authenticated`.
--
-- The REVOKE is aimed at `anon` and `authenticated` BY NAME and never at PUBLIC. Revoking from
-- PUBLIC on a default ACL also strips `service_role`, which would break every server path in the
-- module; that has bitten this repo before. `service_role` is re-asserted below purely so this
-- migration is self-describing and survives being replayed into a fresh database.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────────
--
-- `grant insert, update, delete, truncate, references, trigger on <table> to anon, authenticated;`
-- No data is read, written or deleted by this migration, and no object is dropped.
-- ─────────────────────────────────────────────────────────────────────────────

revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_control_settings from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_distributors from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_products from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_request_types from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_review_routing from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.marketing_workflow_steps from anon, authenticated;

-- The server is the only writer, and stays the only writer.
grant select, insert, update, delete on table public.marketing_control_settings to service_role;
grant select, insert, update, delete on table public.marketing_distributors     to service_role;
grant select, insert, update, delete on table public.marketing_products         to service_role;
grant select, insert, update, delete on table public.marketing_request_types    to service_role;
grant select, insert, update, delete on table public.marketing_review_routing   to service_role;
grant select, insert, update, delete on table public.marketing_workflow_steps   to service_role;
