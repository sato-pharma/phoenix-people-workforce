-- marketing_direct_orders_count_by_default
--
-- WHAT THIS CHANGES: `marketing_requests.track_direct_sales` now defaults to TRUE, and every
--   existing request that carried FALSE is switched to TRUE -- except a service-fee settlement request
--   (one with a row in `direct_order_marketing_offsets`), which stays FALSE on purpose. No function
--   body changes: `phx_marketing_request_sales_lines` and `phx_refresh_marketing_roi_facts` still gate
--   their direct branch on this flag, so the matching rule, the window and the product test are
--   exactly what they were.
--
-- WHY: owner instruction 2026-10-18 -- a direct order placed at a campaign's own pharmacy, for one of
--   the campaign's products, in a month inside the campaign's ROI window, counts in that campaign's
--   ROI, with nobody switching it on per campaign ("Automatic"). Until now it counted only for the one
--   request a Super Admin had switched on by hand, so 64 of 65 campaigns ignored their direct orders.
--   The window stays the pay month through `roi_duration_months` (his answer to the same question).
--
-- MEASURED ON PRODUCTION 2026-10-18 (read-only, the direct branch's own joins with the flag ignored):
--   the change newly credits 3 request/order pairs of EGP 2,007.90 each -- one active campaign, one
--   rejected, one still pending approval -- and one of the orders is claimed by two campaigns. The
--   attribution ledger behind the roll-up dedupe holds invoice rows only, so a direct order claimed by
--   two APPROVED campaigns would be added twice in a company-wide roll-up. Today only one of the two
--   claimants is approved, so no roll-up is affected; building the dedupe is a separate change.
--
-- KEPT ON PURPOSE: the settlement request `phx_admin_settle_service_fee` raises writes
--   `track_direct_sales = false` explicitly, so it never reads the new default; the backfill below
--   leaves the one existing settlement request alone for the same reason. The Super Admin switch on the
--   case file still works and is now an opt-OUT for one campaign.
--
-- ROLLBACK: restore the old default and the old state --
--   alter table public.marketing_requests alter column track_direct_sales set default false;
--   update public.marketing_requests set track_direct_sales = false
--    where request_code <> 'MKT-REQ-20260816-8E4E42C4';   -- the one campaign the owner left on (2026-10-09)
--   then select public.phx_refresh_marketing_roi_facts(null);
--
-- After it applies, run `select public.phx_refresh_marketing_roi_facts(null);` once -- the hourly job
-- (`phoenix-marketing-roi-refresh`, :20) would otherwise leave the stored facts a tick behind.

begin;

alter table public.marketing_requests
  alter column track_direct_sales set default true;

update public.marketing_requests mr
   set track_direct_sales = true
 where mr.track_direct_sales = false
   and not exists (
     select 1
       from public.direct_order_marketing_offsets o
      where o.marketing_request_id = mr.id
   );

comment on column public.marketing_requests.track_direct_sales is
  'When true (the default since 2026-10-18), ROI actuals also include approved Direct Order Request sales at this campaign''s target pharmacies for its own products, matched by the shared distributor customer code and counted in the months of the campaign''s ROI window. A Super Admin can switch it off for one campaign; a service-fee settlement request is created with it off.';

commit;
