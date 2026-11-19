-- drop_superseded_collection_and_cancel_forms
--
-- WHAT THIS CHANGES: drops the two earlier forms that 20261119145916 left beside their record-writing successors:
--   public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date)   (from 20261113161617)
--   public.phx_cancel_marketing_request(uuid, text, text, timestamptz)               (from 20261113161619)
--   The forms the app calls stay exactly as they are:
--   public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date, jsonb, jsonb)
--   public.phx_cancel_marketing_request(uuid, text, text, timestamptz, jsonb)
-- WHY: REC-038 close-out, 19 Nov 2026 (owner: "drop the old collection and cancel function forms"). The earlier forms
--   were kept only so the code serving before #614 kept working between that migration's apply and the deploy. #614 is
--   live on production since 15:18 Cairo, and nothing calls the earlier forms any more: recordDirectOrderCollection and
--   cancelMarketingRequest send p_audit (and p_event), which only the new forms take, and no database function, script
--   or job names either function. Left in place, the earlier forms were a way to collect or cancel WITHOUT writing the
--   record, through the service role.
-- ROLLBACK: re-create the earlier forms by re-applying 20261113161617_direct_order_collection_atomic.sql and
--   20261113161619_marketing_decide_requires_pending_request.sql (both `create or replace`; the second also re-creates
--   phx_decide_marketing_request_step with the body it already has). Only needed if #614 is reverted.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here touches a row: two unused function forms are dropped, and `if exists` makes a re-run a no-op.

begin;

drop function if exists public.phx_record_direct_order_collection(uuid, numeric, date, numeric, date);
drop function if exists public.phx_cancel_marketing_request(uuid, text, text, timestamptz);

notify pgrst, 'reload schema';

commit;
