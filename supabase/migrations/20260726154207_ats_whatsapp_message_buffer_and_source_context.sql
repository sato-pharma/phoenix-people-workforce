-- Recruitment / ATS — surface the source context of an inbound CV (the email subject, or the
-- first few WhatsApp messages) on the candidate.
--
-- Two parts:
--
-- 1. ats_whatsapp_inbound_messages — a short-lived buffer of the plain text messages a sender
--    sends over WhatsApp. They arrive as their own webhook events, separate from (and usually
--    just before) the document message that actually carries the CV, so they must be parked
--    somewhere until that document arrives and a candidate exists to attach them to. Rows are
--    consumed (deleted) when a CV document from the same sender is processed, and any stragglers
--    are swept by a retention window so this never grows unbounded.
--
-- 2. ats_candidate_source_context — a read view giving, per candidate, the single most recent
--    intake event. The candidate list/profile reads it to show "where this CV came from": the
--    email subject for email, or the caption + first messages (already assembled into
--    raw_metadata by the WhatsApp webhook) for WhatsApp. No new columns on ats_cv_intake_events —
--    the WhatsApp context lives in the existing raw_metadata jsonb.
--
-- Server-only: every reader/writer goes through the service-role client (recruitmentDb()), which
-- bypasses RLS, and the candidate surfaces are already Talent-Acquisition-gated at the route
-- layer. RLS is still enabled on the buffer table with no policies, so the anon/authenticated
-- roles get nothing if the table is ever reached directly.

create table if not exists public.ats_whatsapp_inbound_messages (
    id uuid default gen_random_uuid() not null,
    wa_id text not null,
    body text not null,
    received_at timestamp with time zone not null default now(),
    created_at timestamp with time zone not null default now(),
    constraint ats_whatsapp_inbound_messages_pkey primary key (id)
);

comment on table public.ats_whatsapp_inbound_messages is
    'Short-lived buffer of inbound WhatsApp text messages per sender (wa_id), held until that sender''s CV document arrives so the first few messages can be attached to the candidate. Consumed on CV intake; swept by retention.';

create index if not exists ats_whatsapp_inbound_messages_wa_id_received_idx
    on public.ats_whatsapp_inbound_messages using btree (wa_id, received_at desc);

create index if not exists ats_whatsapp_inbound_messages_received_at_idx
    on public.ats_whatsapp_inbound_messages using btree (received_at);

alter table public.ats_whatsapp_inbound_messages enable row level security;

-- Per-candidate most-recent intake event. DISTINCT ON keeps exactly one row per candidate (the
-- latest by created_at), so the candidate list can LEFT JOIN / look up source context without a
-- correlated subquery per row.
create or replace view public.ats_candidate_source_context as
select distinct on (event.candidate_id)
    event.candidate_id,
    event.channel,
    event.subject,
    event.sender_display_name,
    event.sender_identifier,
    event.raw_metadata,
    event.created_at
from public.ats_cv_intake_events as event
where event.candidate_id is not null
order by event.candidate_id, event.created_at desc;

comment on view public.ats_candidate_source_context is
    'One row per candidate: their most recent inbound-CV intake event. Reads the email subject (email) or the caption + first messages parked in raw_metadata (WhatsApp) for the candidate list/profile "source" column.';
