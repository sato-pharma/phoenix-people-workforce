-- direct_order_receipt_books
--
-- WHAT THIS CHANGES: two new tables, service role only.
--   public.direct_order_receipt_books  one row per printed delivery-receipt book (16 books, 50 receipts each).
--   public.direct_order_receipts       one row per printed receipt: its six-digit serial, the six-character code
--                                      printed beside it, and — once used — the ONE direct order it proves.
-- Every receipt page carries a serial and a random code. A District Manager delivering a direct order fills one,
-- the venue signs and stamps it, and he enters the serial, the code and a photo of the signed page on the order.
-- Phoenix accepts it only when the code matches the serial, the book is issued to the order's requester, and the
-- receipt has never been used: `request_id` is UNIQUE and `state` moves unused -> used exactly once, so one paper
-- can never prove two orders and an invented page (wrong code) is refused.
-- Finance issues, returns and reports a book lost on the Receipt Books desk (owner, 26 Nov 2026: "Finance").
-- An approved order with no receipt 14 days after approval is flagged there (owner, 26 Nov 2026: "14 days").
--
-- The rows themselves (the books and every serial with its code) are NOT in this file: the codes are printed on
-- paper that is the evidence, and they never enter Git. scripts/seed-direct-order-receipt-books.mjs loads them
-- from the printer's register.json.
--
-- WHY: owner, 26 Nov 2026 — numbered receipt books as custody for every direct-order delivery, "a thing that
-- cannot be printed twice", checked in Phoenix ("Build the check").
--
-- ROLLBACK: drop table public.direct_order_receipts; drop table public.direct_order_receipt_books;
--   (Nothing existing is changed. Dropping loses which receipt proved which order, so export the used rows first.)
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: two new empty tables.

begin;
set local lock_timeout = '5s';

create table if not exists public.direct_order_receipt_books (
  book_no smallint primary key check (book_no > 0),
  first_serial integer not null check (first_serial > 0),
  last_serial integer not null,
  -- The District Manager whose name is PRE-PRINTED on every page of the book; null on a spare book printed blank.
  printed_holder_hr_id text,
  -- Who holds the book now. Set when Finance issues it; kept after it is returned or lost, so an old order still
  -- reads whose book proved it.
  holder_hr_id text,
  status text not null default 'in_store' check (status in ('in_store', 'issued', 'returned', 'lost')),
  issued_at timestamptz,
  issued_by_hr_id text,
  closed_at timestamptz,
  closed_by_hr_id text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_order_receipt_books_range check (last_serial >= first_serial),
  constraint direct_order_receipt_books_issued check (
    status = 'in_store' or (holder_hr_id is not null and issued_at is not null)
  ),
  constraint direct_order_receipt_books_closed check (
    status not in ('returned', 'lost') or closed_at is not null
  )
);

comment on table public.direct_order_receipt_books is
  'Printed direct-order delivery-receipt books held as custody by District Managers (owner, 26 Nov 2026). Finance issues, returns and reports them lost. Service role only. See src/lib/direct-orders/receipt-books.ts.';

create table if not exists public.direct_order_receipts (
  serial integer primary key check (serial > 0),
  book_no smallint not null references public.direct_order_receipt_books (book_no),
  -- The random code printed beside the serial: six characters of 23456789ABCDEFGHJKMNPQRSTUVWXYZ.
  check_code text not null check (check_code ~ '^[2-9A-HJKMNP-Z]{6}$'),
  state text not null default 'unused' check (state in ('unused', 'used', 'voided')),
  -- The ONE direct order this receipt proves. Unique: one paper, one order, for ever.
  request_id uuid unique references public.direct_order_requests (id),
  photo_storage_path text,
  photo_content_type text,
  used_by_hr_id text,
  used_at timestamptz,
  voided_reason text,
  voided_by_hr_id text,
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint direct_order_receipts_used check (
    (state = 'used') = (request_id is not null)
    and (state <> 'used' or (photo_storage_path is not null and used_at is not null and used_by_hr_id is not null))
  ),
  constraint direct_order_receipts_voided check (
    state <> 'voided' or (voided_reason is not null and voided_at is not null)
  )
);

comment on table public.direct_order_receipts is
  'One row per printed delivery receipt: serial, the printed check code, and the one direct order it proves once used. A receipt moves unused -> used once; request_id is unique. Codes are never sent to a browser. Service role only.';

create index if not exists direct_order_receipts_book_idx on public.direct_order_receipts (book_no, state);

alter table public.direct_order_receipt_books enable row level security;
create policy direct_order_receipt_books_service_role
  on public.direct_order_receipt_books for all to service_role using (true) with check (true);
revoke all on table public.direct_order_receipt_books from public, anon, authenticated;
grant all on table public.direct_order_receipt_books to service_role;

alter table public.direct_order_receipts enable row level security;
create policy direct_order_receipts_service_role
  on public.direct_order_receipts for all to service_role using (true) with check (true);
revoke all on table public.direct_order_receipts from public, anon, authenticated;
grant all on table public.direct_order_receipts to service_role;

notify pgrst, 'reload schema';

commit;
