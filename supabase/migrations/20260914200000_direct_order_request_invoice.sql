-- The distributor invoice a rep used, kept WITH THE ORDER.
--
-- WHY. Owner, 2026-09-14: "when the pharmacies validate by invoices goes to SFE to validate it must
-- clearly show the invoice pic used". Reps read the invoice on the order form ("Fill from the
-- invoice"), and that reader stored nothing — so the SFE Manager, the first approver on every order,
-- decided a new pharmacy with no invoice in front of them. These columns keep the file on the order
-- itself, so it is shown whether or not a validation claim was ever filed.
--
-- The file lives in the private `direct-order-invoices` bucket created by
-- 20260914180000_direct_order_invoice_validation.sql. Nothing here touches the workflow registry:
-- attaching a file changes no order status, the same as booking a sales month.

begin;

alter table public.direct_order_requests
  add column if not exists invoice_storage_path text,
  add column if not exists invoice_content_type text,
  add column if not exists invoice_uploaded_at timestamptz;

comment on column public.direct_order_requests.invoice_storage_path is
  'The distributor invoice the requester used for this order, in the private direct-order-invoices bucket.';
comment on column public.direct_order_requests.invoice_content_type is
  'image/jpeg, image/png or application/pdf — what the approver''s browser is asked to open.';

alter table public.direct_order_requests
  drop constraint if exists direct_order_requests_invoice_content_type_check;
alter table public.direct_order_requests
  add constraint direct_order_requests_invoice_content_type_check
  check (
    invoice_content_type is null
    or invoice_content_type = any (array['image/jpeg'::text, 'image/png'::text, 'application/pdf'::text])
  );

-- A path with no type would render as a broken image, and a type with no path as an invoice that
-- is not there. Both or neither.
alter table public.direct_order_requests
  drop constraint if exists direct_order_requests_invoice_pair_check;
alter table public.direct_order_requests
  add constraint direct_order_requests_invoice_pair_check
  check ((invoice_storage_path is null) = (invoice_content_type is null));

notify pgrst, 'reload schema';

commit;
