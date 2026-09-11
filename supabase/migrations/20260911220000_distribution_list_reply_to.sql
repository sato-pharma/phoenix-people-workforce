-- A distribution list can carry its own Reply-To, and the HR Team list carries the HR Business
-- Partner's mailbox.
--
-- Owner 2026-09-11: "i want the email used in this module sending any emails be
-- HRBP@satopharma.com". Held on the LIST rather than set globally, because the lists do not share
-- an owner: `closing_fixed_cc` is a sales audience and `finance_team` is Finance's, and a global
-- setting would have made a Monthly Closing publish reply to HR.
--
-- 🔴 REPLY-TO, NOT FROM, AND THAT IS NOT A DETAIL. `systemEmail.defaultFromEmail` is
-- `phoenix@send.satopharma.com` — a SUBDOMAIN, which is what Resend authenticates (DKIM/SPF).
-- Sending as `HRBP@satopharma.com` would be sending as the apex domain, which is either rejected
-- or filed as spam unless satopharma.com is itself verified for sending. Reply-To carries no
-- deliverability risk and is what actually decides where a reply lands, which is what was asked
-- for. The mailbox was confirmed to exist by the owner the same day — it has to, or every reply
-- bounces in silence.
--
-- NULL means "use the system default" (`NOTIFICATION_REPLY_TO`, else systemEmail.defaultReplyTo),
-- so an untouched list behaves exactly as it did before this column existed.
begin;

alter table public.distribution_lists
  add column if not exists reply_to text
    check (reply_to is null or reply_to = lower(reply_to));

comment on column public.distribution_lists.reply_to is
  'Reply-To for a send addressed through this list. NULL = the system default. Never used as the From address: From must stay on the verified sending subdomain.';

update public.distribution_lists
set reply_to = 'hrbp@satopharma.com',
    updated_at = now(),
    updated_by = 'migration:distribution_list_reply_to'
where list_key = 'hr_team'
  and reply_to is null;

commit;
