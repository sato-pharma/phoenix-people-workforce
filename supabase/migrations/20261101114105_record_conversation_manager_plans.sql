-- record_conversation_manager_plans
--
-- WHAT THIS CHANGES: record_conversation_comments.module also accepts 'manager_plans', so a manager's
-- Phoenix CRM weekly plan can hold a conversation in the same append-only table as direct orders and
-- marketing requests. record_id is the plan's own id. No row changes and no other column moves.
-- WHY: the owner, 2026-11-01: "in new managers weekly plan i want an option to open conversation and
-- people in approval window visible to it today the weekly plan have no conversation".
-- ROLLBACK: put the two-value check back, once no 'manager_plans' row remains (the check would refuse them):
--   alter table public.record_conversation_comments drop constraint record_conversation_comments_module_known;
--   alter table public.record_conversation_comments add constraint record_conversation_comments_module_known
--     check (module in ('direct_orders', 'marketing_requests'));
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied. This is neither.

begin;

alter table public.record_conversation_comments
  drop constraint if exists record_conversation_comments_module_known;

alter table public.record_conversation_comments
  add constraint record_conversation_comments_module_known
  check (module in ('direct_orders', 'marketing_requests', 'manager_plans'));

comment on column public.record_conversation_comments.module is
  'Record type: direct_orders | marketing_requests | manager_plans.';

comment on column public.record_conversation_comments.record_id is
  'The direct order / marketing request / manager weekly plan id (uuid, held as text).';

commit;
