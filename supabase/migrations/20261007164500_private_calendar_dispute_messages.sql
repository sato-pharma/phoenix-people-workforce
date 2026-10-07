-- Private Calendar review requests become a two-way conversation.
--
-- Until now a review request was one shot each way: the employee typed one claim, the Super Admin
-- typed one decision note, and there was nowhere to ask "which manager confirmed it?" before
-- deciding. This table is the thread under one review request — every reply, from either side, in
-- the order it was written. The request's own `claim_text` stays where it is and reads as the first
-- message in that thread; nothing is backfilled here.
--
-- RLS-enabled with NO policies -> service-role only, like the parent table: the browser never reads
-- this directly, the server reads it with getSupabaseAdmin().

begin;

create table if not exists public.private_calendar_dispute_messages (
    id uuid primary key default gen_random_uuid(),
    dispute_id uuid not null
        references public.private_calendar_data_disputes (id) on delete cascade,
    -- Who wrote it, in the storage form (upper-case HR id). The NAME is resolved from `employees` at
    -- read time, never stored here — the owner's standing rule is names and not ids on every surface,
    -- and resolving late means a rename corrects the whole thread instead of only its new lines.
    author_hr_id text not null,
    -- true when an admin wrote it. Stored rather than derived: the author's ROLE at the time is what
    -- the thread should keep showing, and a role can change under a historical message.
    author_is_admin boolean not null default false,
    body text not null,
    created_at timestamptz not null default now(),
    constraint private_calendar_dispute_messages_body_check check (length(trim(body)) > 0)
);

comment on table public.private_calendar_dispute_messages is
    'Replies on one private-calendar review request (private_calendar_data_disputes). Append-only conversation between the employee who raised it and the Super Admin reviewing it; the request own claim_text is the first message and is not duplicated here.';

create index if not exists private_calendar_dispute_messages_dispute_idx
    on public.private_calendar_dispute_messages (dispute_id, created_at);

alter table public.private_calendar_dispute_messages enable row level security;

notify pgrst, 'reload schema';

commit;
