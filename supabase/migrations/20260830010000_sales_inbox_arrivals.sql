-- Sales mailbox intake — the register of distributor workbooks that arrived by email.
--
-- WHY THIS EXISTS. Measured on production 2026-08-29, before anything here was designed:
--
--   17  distributor files were imported for period 2026-07 (18 in June, 17 in May, 19 in April —
--       so this is the steady shape of a month, not one unusual close).
--   10  days separated the first upload of that period from the last (2026-08-02 -> 2026-08-12).
--
-- Every one of those 17 files reached the company as an email attachment and then had to be
-- carried by hand into Phoenix: notice it, download it, open the Monthly Sales wizard, find the
-- matching distributor in the list, pick the file off disk, upload. Seventeen times, spread over
-- ten days, at exactly the moment of the month when everything else is also due.
--
-- Nothing about that work needs a person. The mailbox can be read; the workbook's own header row
-- already identifies which distributor sent it (detectDistributorFromBuffer, the same detection
-- the upload screen uses to pre-select the dropdown); and the file can be put straight into the
-- sales-imports bucket, which is where the wizard's preview and commit already read from
-- (resolveSalesUploadRequest accepts a storagePath). So the arrival, the download and the
-- attribution are all machine work. This table is what remembers that they happened.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO: IT NEVER IMPORTS.
-- ---------------------------------------------------------------------------
-- A row here means "a file arrived and this is who we think sent it". It does not mean the file
-- is good, that its period is right, or that its numbers belong in a closing. The human still
-- opens it, still reads the preview, still commits — which is the standing rule everywhere else
-- in this system: it flags, a person decides. A monthly closing is the most consequential number
-- the company produces, and an auto-import would be the one place where nobody ever looked.
--
-- It also notifies NOBODY. No mail, no in-app, no Telegram, no push. The arrivals are shown where
-- the work already happens (the Monthly Sales wizard, on the step for that distributor), so the
-- person who is already doing the close finds them without being interrupted, and the person who
-- is not doing the close is not told about a file they have no use for.
--
-- ---------------------------------------------------------------------------
-- WHY A FILE WE CANNOT ATTRIBUTE IS STILL RECORDED.
-- ---------------------------------------------------------------------------
-- detected_distributor_code is nullable on purpose. A workbook whose headers match no profile is
-- the single most interesting thing this poller can find — a distributor changed their export, or
-- a new one started sending — and dropping it silently would turn a discovery into a file that
-- was never mentioned to anyone. It lands with status 'arrived' and no distributor, and the
-- wizard shows it as unrecognised so a person can attribute it in one click.

create table if not exists public.sales_inbox_arrivals (
    id uuid primary key default gen_random_uuid(),

    -- Where it came from. (mailbox_label, imap_uidvalidity, uid, attachment_index) is the identity
    -- of one attachment on one message. UIDVALIDITY is part of it because a server-side mailbox
    -- rebuild resets UIDs to 1, and without it a brand-new message could collide with an old one's
    -- key and be silently swallowed by the unique index as a duplicate.
    mailbox_label text not null,
    folder_path text not null,
    imap_uidvalidity bigint not null,
    uid bigint not null,
    attachment_index integer not null default 0,
    message_id text,

    -- Who sent it, for the person reading the list. Kept verbatim from the message.
    from_address text,
    from_name text,
    subject text,
    received_at timestamp with time zone,

    -- The file itself, parked in the same bucket the upload screen uses so that preview/commit
    -- need no new transport: they already accept a storagePath into sales-imports.
    file_name text not null,
    file_size_bytes bigint not null default 0,
    storage_bucket text not null default 'sales-imports',
    storage_path text not null,

    -- Who we think sent it, from the workbook's header row alone. Null = recognised by nothing.
    detected_distributor_code text,
    detected_distributor_name text,
    detection_confidence text not null default 'none',
    detection_ambiguous boolean not null default false,
    detection_matches jsonb,

    -- 'arrived'   — waiting for a person
    -- 'claimed'   — imported through the wizard; claimed_batch_id records what it became
    -- 'dismissed' — a person said this is not a sales file (or is a duplicate send)
    status text not null default 'arrived',
    claimed_period text,
    claimed_batch_id uuid,
    claimed_by text,
    claimed_at timestamp with time zone,
    dismissed_reason text,
    dismissed_by text,

    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now(),

    constraint sales_inbox_arrivals_status_check
        check (status in ('arrived', 'claimed', 'dismissed')),
    -- Exactly the three tiers detectDistributor produces. Kept tight rather than permissive: the
    -- job of this constraint is to catch a writer that has drifted from the detector, and a
    -- superset would let precisely that through.
    constraint sales_inbox_arrivals_confidence_check
        check (detection_confidence in ('high', 'low', 'none'))
);

comment on table public.sales_inbox_arrivals is
    'Distributor sales workbooks that arrived by email, parked in the sales-imports bucket and attributed by header detection. A row NEVER means the file was imported - the Monthly Sales wizard still requires a person to preview and commit it.';

comment on column public.sales_inbox_arrivals.detected_distributor_code is
    'Best-matching distributor from the workbook header row alone. NULL means no profile matched, which is recorded rather than dropped: an unrecognised workbook usually means a distributor changed their export format.';

-- The idempotency guard. The poller re-reads a folder whenever its cursor is behind, and a
-- UIDVALIDITY reset makes it re-walk from a backfill window, so the same attachment can be offered
-- more than once. This index is what makes that a no-op instead of a duplicate.
create unique index if not exists sales_inbox_arrivals_source_key
    on public.sales_inbox_arrivals (mailbox_label, imap_uidvalidity, uid, attachment_index);

-- The wizard's read: everything still waiting, newest first.
create index if not exists sales_inbox_arrivals_status_received
    on public.sales_inbox_arrivals (status, received_at desc);

-- The per-step read: the arrivals for the distributor whose step is open.
create index if not exists sales_inbox_arrivals_distributor
    on public.sales_inbox_arrivals (detected_distributor_code, status);

create table if not exists public.sales_email_intake_cursors (
    mailbox_label text not null,
    imap_uidvalidity bigint,
    last_processed_uid bigint not null default 0,
    updated_at timestamp with time zone not null default now(),
    constraint sales_email_intake_cursors_pkey primary key (mailbox_label)
);

comment on table public.sales_email_intake_cursors is
    'IMAP polling watermark per mailbox+folder for the sales inbox intake. Deliberately a persisted cursor rather than the IMAP Seen flag: the sales mailbox is read by people too, and flipping Seen on bot-read messages would rewrite what they see as unread. Mirrors ats_email_intake_cursors, with its own rows so the two pollers can never disturb each other.';

alter table public.sales_inbox_arrivals enable row level security;
alter table public.sales_email_intake_cursors enable row level security;

drop policy if exists phx_sales_inbox_arrivals_service_role on public.sales_inbox_arrivals;
create policy phx_sales_inbox_arrivals_service_role
    on public.sales_inbox_arrivals
    to service_role using (true) with check (true);

drop policy if exists phx_sales_email_intake_cursors_service_role on public.sales_email_intake_cursors;
create policy phx_sales_email_intake_cursors_service_role
    on public.sales_email_intake_cursors
    to service_role using (true) with check (true);

grant all on table public.sales_inbox_arrivals to service_role;
grant all on table public.sales_email_intake_cursors to service_role;
