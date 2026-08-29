-- An audit record of every WhatsApp message Phoenix SENDS.
--
-- Why this exists: on 2026-08-30 the owner asked a simple question — "show me the reply that went
-- out" — and it could not be answered from the database. Phoenix stored the inbound side twice
-- (`ats_whatsapp_inbound_messages`, `ats_cv_intake_events`) and the outbound side not at all. The
-- only tables in production matching '%whatsapp%' were both inbound. So the honest answer was a
-- RECONSTRUCTION: read the code that was live at that second and render what it would have
-- produced. That works only while the code is still reachable and the reasoning is still correct,
-- and it fails completely the moment a message is composed from data (a name, an area, a vacancy)
-- rather than from a constant.
--
-- What that cost, concretely. At 01:28:37 Cairo a real applicant asked about the Gharbia 1 advert
-- and was answered with a generic "send your CV as a file". `notification_events` proved a reply
-- was sent (`asked: true`) but held no copy of it. Every claim about what he actually read had to
-- be inferred. These are messages sent to members of the public in the company's name; what left
-- the building should be a record, not an inference.
--
-- One row per completed send attempt, successes AND failures, written by the single Graph
-- chokepoint every outbound path already funnels through.

begin;

create table if not exists public.ats_whatsapp_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Who it went to, and which line it went FROM. The second column is not redundant: once two
  -- numbers feed one webhook (the coexistence case), replying from the wrong line opens a
  -- conversation the applicant never started, and that is invisible without recording the sender.
  to_wa_id text not null,
  phone_number_id text not null,

  -- 'text' | 'interactive'. Kept as free text rather than an enum so a new Graph message type
  -- cannot fail a send by failing its audit row — see the never-throws note below.
  message_type text not null,

  -- THE POINT OF THE TABLE: the exact words that reached the person. Null for an interactive menu,
  -- whose content lives in `payload` instead.
  body text,

  -- The Graph payload as sent, verbatim. Never carries the access token — that is a header, and
  -- this is the request body only.
  payload jsonb,

  -- The existing log label of the call site ('whatsapp_classify_text_send', etc.), so a row can be
  -- traced back to the code path that produced it without guessing.
  event text not null,

  -- What this was replying to, when the caller knows. This is what turns the table from "what did
  -- we send" into "what did we send THIS PERSON about THAT message".
  inbound_wamid text,
  context jsonb,

  -- The outcome, recorded after Meta answered.
  ok boolean not null,
  provider_message_id text,
  failure_reason text,
  failure_detail text,

  constraint ats_whatsapp_outbound_messages_failure_reason_check
    check (failure_reason is null or failure_reason in ('disabled', 'invalid_menu', 'window_closed', 'failed')),

  -- A successful send has no failure; a failed one has no wamid. Keeping this as a constraint
  -- rather than a convention means a half-written row cannot quietly become evidence.
  constraint ats_whatsapp_outbound_messages_outcome_check
    check ((ok and failure_reason is null) or (not ok and failure_reason is not null))
);

-- The two questions this table gets asked. "What did we send this number, most recently" is the
-- owner's question verbatim; "what went out in the last hour" is the one a session asks after a
-- deploy.
create index if not exists ats_whatsapp_outbound_messages_to_created_idx
  on public.ats_whatsapp_outbound_messages (to_wa_id, created_at desc);

create index if not exists ats_whatsapp_outbound_messages_created_idx
  on public.ats_whatsapp_outbound_messages (created_at desc);

-- Answers "what did the reply say to THIS message" in one lookup. Partial, because the column is
-- null for anything not sent in reply to a specific inbound message.
create index if not exists ats_whatsapp_outbound_messages_inbound_idx
  on public.ats_whatsapp_outbound_messages (inbound_wamid)
  where inbound_wamid is not null;

comment on table public.ats_whatsapp_outbound_messages is
  'Every WhatsApp message Phoenix sent: exact text, recipient, sending line, and outcome. Written by postToGraph after Meta answers. Never blocks a send.';

comment on column public.ats_whatsapp_outbound_messages.body is
  'The exact text delivered to the recipient. This is the column that exists so "show me the reply that went out" is a query, not a reconstruction from source code.';

comment on column public.ats_whatsapp_outbound_messages.ok is
  'Whether Meta accepted the message. A false row is a message the person never received — do not read this table as a delivery receipt: Meta accepting is not the handset showing it.';

-- ---------------------------------------------------------------------------
-- RLS and grants
-- ---------------------------------------------------------------------------

-- `public` is the only schema PostgREST exposes and Supabase grants `anon` SELECT on new tables
-- there by default, so RLS is not optional here — this table holds applicants' phone numbers
-- alongside what we said to them. Visibility in this app is application-scoped (AGENTS.md §8):
-- every read goes through the service-role client behind an assertPermission call, and RLS on with
-- no authenticated grant is the norm in this database (222 of 308 tables). No browser session
-- reaches this table at all.
alter table public.ats_whatsapp_outbound_messages enable row level security;

revoke all on table public.ats_whatsapp_outbound_messages from anon, authenticated;
grant select, insert on table public.ats_whatsapp_outbound_messages to service_role;

commit;
