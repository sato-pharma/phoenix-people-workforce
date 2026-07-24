-- Recruitment / ATS — automated CV intake (email + WhatsApp), phase 1: schema only.
--
-- recruitment_cv_intake_events is the audit trail for every inbound message a poller/webhook
-- attempts to turn into a candidate: outcome records what actually happened (candidate created,
-- matched an existing one, ignored for lacking a usable attachment, or errored), so two brand-new
-- external integrations stay debuggable instead of opaque. The unique index on
-- (channel, provider_message_id) is also the idempotency claim key — a poller/webhook inserts a
-- 'processing' row via `on conflict do nothing` before doing any work; getting no row back means
-- another run already owns this message.
--
-- recruitment_email_intake_cursors is the IMAP polling watermark, one row per mailbox. Deliberately
-- a persisted UID cursor rather than the IMAP \Seen flag: careers@/hr@ are shared, human-monitored
-- mailboxes, and flipping \Seen on bot-processed messages would pollute what HR staff see as
-- unread (and an UNSEEN-filtered poll would race with a human opening a message first).

begin;

create table if not exists public.recruitment_cv_intake_events (
    id uuid default gen_random_uuid() not null,
    channel text not null,
    mailbox_label text,
    provider_message_id text,
    provider_uid text,
    sender_identifier text,
    sender_display_name text,
    subject text,
    outcome text not null default 'processing',
    candidate_id uuid,
    file_id uuid,
    match_reason text,
    error_message text,
    raw_metadata jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone default now() not null,
    updated_at timestamp with time zone default now() not null,
    constraint recruitment_cv_intake_events_pkey primary key (id),
    constraint recruitment_cv_intake_events_channel_check
        check (channel in ('email', 'whatsapp')),
    constraint recruitment_cv_intake_events_outcome_check
        check (outcome in (
            'processing', 'candidate_created', 'candidate_matched',
            'ignored_no_attachment', 'ignored_unsupported_attachment',
            'ignored_duplicate', 'error'
        )),
    constraint recruitment_cv_intake_events_candidate_id_fkey
        foreign key (candidate_id) references public.recruitment_candidates(id) on update cascade on delete set null,
    constraint recruitment_cv_intake_events_file_id_fkey
        foreign key (file_id) references public.recruitment_files(id) on update cascade on delete set null
);

comment on table public.recruitment_cv_intake_events is
    'One row per inbound email/WhatsApp message an intake poller or webhook attempted to turn into a candidate. The (channel, provider_message_id) unique index doubles as the idempotency claim key.';

create unique index if not exists recruitment_cv_intake_events_channel_msg_uniq
    on public.recruitment_cv_intake_events using btree (channel, provider_message_id)
    where provider_message_id is not null;

create index if not exists recruitment_cv_intake_events_candidate_id_idx
    on public.recruitment_cv_intake_events using btree (candidate_id);

create index if not exists recruitment_cv_intake_events_created_at_idx
    on public.recruitment_cv_intake_events using btree (created_at desc);

create table if not exists public.recruitment_email_intake_cursors (
    mailbox_label text not null,
    imap_uidvalidity bigint,
    last_processed_uid bigint not null default 0,
    updated_at timestamp with time zone default now() not null,
    constraint recruitment_email_intake_cursors_pkey primary key (mailbox_label)
);

comment on table public.recruitment_email_intake_cursors is
    'IMAP polling watermark per mailbox (last_processed_uid). A UIDVALIDITY change resets the cursor to 0 for that mailbox; the recruitment_cv_intake_events claim key is the safety net against reprocessing in that case.';

alter table public.recruitment_cv_intake_events enable row level security;
alter table public.recruitment_email_intake_cursors enable row level security;

create policy phx_recruitment_cv_intake_events_service_role
    on public.recruitment_cv_intake_events
    to service_role using (true) with check (true);

create policy phx_recruitment_email_intake_cursors_service_role
    on public.recruitment_email_intake_cursors
    to service_role using (true) with check (true);

grant all on table public.recruitment_cv_intake_events to service_role;
grant all on table public.recruitment_email_intake_cursors to service_role;

notify pgrst, 'reload schema';

commit;
