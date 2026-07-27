-- Durable queue for inbound CV intake (WhatsApp webhook + email poll).
--
-- Motivation: the WhatsApp webhook used to do media download + AI + candidate creation
-- synchronously before returning 200. Under a bulk-forward burst that can exceed Meta's
-- webhook timeout, and Meta disables a webhook that keeps timing out — a self-inflicted
-- outage. It also meant any transient failure (media 5xx, OpenAI blip, storage hiccup) was
-- lost forever: the webhook had already 200'd and the (channel, provider_message_id) claim
-- in ats_cv_intake_events made a replay dedupe away.
--
-- This queue decouples receipt from processing. The webhook/poller ENQUEUE (fast, cheap) and
-- a worker cron drains this table, re-materializing the bytes (WhatsApp: download by media id;
-- email: re-fetch by IMAP UID) and running the existing ingestInboundCv. Failures retry with
-- backoff and dead-letter after max_attempts instead of vanishing. Additive + non-destructive;
-- mirrors public.background_jobs (see 20260711140000_background_jobs.sql).

create table if not exists public.ats_inbound_intake_queue (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('whatsapp', 'email')),
  -- The idempotency key: WhatsApp wamid, or email <messageId>[#attachmentIndex]. A unique
  -- (channel, provider_message_id) makes enqueue insert-on-conflict-do-nothing, so a redelivered
  -- webhook or a re-seen UID never creates a second queue row (and ingestInboundCv's own claim is
  -- the second line of defence).
  provider_message_id text not null,
  source text not null,                       -- 'whatsapp_webhook' | 'email_poll'
  payload jsonb not null default '{}'::jsonb,  -- references only, never file bytes
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  claimed_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ats_inbound_intake_queue_dedupe
  on public.ats_inbound_intake_queue (channel, provider_message_id);

-- Drives the claim: cheapest first-ready-out ordering.
create index if not exists ats_inbound_intake_queue_claimable
  on public.ats_inbound_intake_queue (status, next_attempt_at);

-- Service-role only; the application enforces access in code (same pattern as background_jobs /
-- app_error_events). RLS enabled with no policies => deny-all for anon/authenticated. The
-- explicit REVOKE is defense-in-depth against the public-schema default grants.
alter table public.ats_inbound_intake_queue enable row level security;
revoke all on public.ats_inbound_intake_queue from anon;
revoke all on public.ats_inbound_intake_queue from authenticated;

-- Atomically claim up to p_limit ready rows. FOR UPDATE SKIP LOCKED guarantees concurrent worker
-- instances never grab the same row. "Ready" = queued and due, OR a processing row abandoned by a
-- worker that died mid-run (claimed_at older than the stale horizon) — the self-healing net that
-- keeps a crash from stranding a CV in 'processing' forever. Every claim increments attempts, so a
-- genuinely poisonous message is bounded and eventually dead-lettered rather than looping.
create or replace function public.claim_next_inbound_intake(p_limit integer default 5)
returns setof public.ats_inbound_intake_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.ats_inbound_intake_queue
     set status = 'processing',
         attempts = attempts + 1,
         claimed_at = now(),
         updated_at = now()
   where id in (
     select id
       from public.ats_inbound_intake_queue
      where (status = 'queued' and next_attempt_at <= now())
         or (status = 'processing' and claimed_at < now() - interval '15 minutes')
      order by next_attempt_at
      for update skip locked
      limit greatest(1, p_limit)
   )
  returning *;
end;
$$;

-- The worker calls this with the service-role key; it must not be publicly callable. REVOKE
-- EXECUTE FROM PUBLIC is the operative one — anon/authenticated inherit EXECUTE via PUBLIC
-- membership, so the two explicit revokes are belt-and-suspenders.
revoke execute on function public.claim_next_inbound_intake(integer) from public;
revoke execute on function public.claim_next_inbound_intake(integer) from anon;
revoke execute on function public.claim_next_inbound_intake(integer) from authenticated;
