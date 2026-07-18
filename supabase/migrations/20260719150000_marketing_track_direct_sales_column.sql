-- Phase D — opt-in flag: when a marketing request has track_direct_sales = true, the
-- ROI engine additionally credits it with the sales from approved Direct Order
-- Requests placed at the campaign's own target pharmacies for the campaign's own
-- products (matched by the shared distributor customer code). Off by default, so
-- every existing request and all ROI math are completely unchanged.

begin;

alter table public.marketing_requests
  add column if not exists track_direct_sales boolean not null default false;

comment on column public.marketing_requests.track_direct_sales is
  'Phase D: when true, ROI actuals also include approved Direct Order Request sales at this campaign''s target pharmacies + products (matched by shared distributor customer code). Default false = ROI unchanged.';

notify pgrst, 'reload schema';

commit;
