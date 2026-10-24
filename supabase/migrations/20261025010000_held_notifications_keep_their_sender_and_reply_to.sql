-- A held email keeps its From and Reply-To, so approving it sends from the same address.
--
-- Owner 2026-10-24: "fix the held-email approval so it keeps the From and Reply-To".
--
-- The Notification Confidence Gate kept a held email's subject, body, recipients and (since
-- 20261025003000) its files, but not who it was from or where replies go. Approving it re-sent with
-- the system default sender and the default Reply-To, so an email a module sent from its own address
-- (and with replies routed to its own inbox) went out on approval from the generic address, and a
-- reply to it landed in the wrong mailbox. Both values are the ones send-phoenix-email.ts had already
-- resolved, and only a HELD send writes them. A row held before this keeps both null and approves
-- with the defaults, exactly as before.
begin;

alter table public.notification_send_reviews
  add column if not exists held_from_address text,
  add column if not exists held_reply_to_address text;

comment on column public.notification_send_reviews.held_from_address is
  'Set only on a held send: the From the send resolved, reused when the held email is approved. Null = held before this was kept; approval uses the default sender.';

comment on column public.notification_send_reviews.held_reply_to_address is
  'Set only on a held send: the Reply-To the send resolved, reused when the held email is approved. Null = held before this was kept; approval uses the default Reply-To.';

notify pgrst, 'reload schema';

commit;
