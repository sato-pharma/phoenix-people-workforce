-- outstation_request_distance_basis
--
-- WHAT THIS CHANGES: adds one nullable jsonb column, outstation_expense_requests.distance_basis.
--   Nothing is written to it here; no existing row changes.
-- WHY: a District Manager's trip is priced from his home to the FIRST double visit he made on it
--   (owner, 2026-11-23). The column keeps what the claim is priced on and both distances — home to
--   where he captured, home to the first double visit — so Expense Approvals shows them side by side
--   (src/lib/outstation/dm-double-visit-distance.ts).
-- ROLLBACK: alter table public.outstation_expense_requests drop column if exists distance_basis;
--   (the money the pricing moved stays on the claim's own columns and in the audit log)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.

begin;

alter table public.outstation_expense_requests
  add column if not exists distance_basis jsonb;

comment on column public.outstation_expense_requests.distance_basis is
  'District Manager trips only: what the travel is priced on (first_double_visit | no_double_visit | unmeasured), the road km from home to the capture point and to the first double visit, and the figures the system left on the claim. Written by src/lib/outstation/dm-double-visit-distance-server.ts. Null for everyone else.';

commit;
