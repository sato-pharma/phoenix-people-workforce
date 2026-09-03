-- Admin manual outstation expenses — an invoice for the Meeting amount (owner request 2026-09-03).
--
-- The admin manual-expense modal already lets an admin type a Meeting amount on someone's behalf,
-- but had nowhere to attach the paperwork behind it. This adds a single-file slot, mirroring the
-- ticket-attachment metadata shape (contentType/name/path/size/uploadedAt) rather than the array
-- columns those use — there is exactly one invoice per request, uploaded and optionally replaced,
-- never a list.
--
-- Nullable, additive, no backfill: every existing row simply has no invoice, which is correct —
-- none of them were ever offered the option.

begin;

alter table public.outstation_expense_requests
  add column if not exists meeting_invoice_path     text,
  add column if not exists meeting_invoice_metadata  jsonb;

comment on column public.outstation_expense_requests.meeting_invoice_path is
  'Storage path (outstation-evidence bucket, meeting-invoice/ prefix) of the uploaded invoice for '
  'a Meeting-type manual expense. Null when no invoice was attached.';

comment on column public.outstation_expense_requests.meeting_invoice_metadata is
  'OutstationTicketAttachmentMetadata shape (contentType/name/path/size/uploadedAt) for the '
  'meeting invoice. Null when meeting_invoice_path is null.';

commit;
