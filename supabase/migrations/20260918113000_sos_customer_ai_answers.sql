-- sos_customer_ai_answers
--
-- WHAT THIS CHANGES: adds one new table, public.source_of_sales_customer_ai_answers. Nothing
--   existing is altered; no row anywhere is written by this migration.
-- WHY: the customer AI suggest in the monthly normalizer paid again for the same pharmacy every
--   time it was asked — Auto-map re-ran the AI over what AI suggest had just paid for, a retry
--   after a cut connection paid again for answers the server had already finished, and a pharmacy
--   stayed a paid question until someone saved it. The owner asked on 2026-09-18 for the cost to
--   come down without losing accuracy. This table keeps the brick the AI named for each distinct
--   pharmacy text (src/lib/sales/normalizer/customer-ai-answers.ts), one row per text and model,
--   so the same question is answered from here instead of paid for again. Read only after the free
--   matching steps, so the map itself (the owner's own saved mappings included) always wins.
--   The app fails open without it: a missing table only means the AI is paid again, as before.
-- ROLLBACK: drop table if exists public.source_of_sales_customer_ai_answers;
--   Dropping it deletes the stored answers only; the next run asks the AI again.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration is additive: one new, empty table.

begin;

create table if not exists public.source_of_sales_customer_ai_answers (
  -- sha256 (hex) of pharmacy_key. The key itself is long Arabic text, too long to look up many at
  -- once in a request URL, so reads go by the hash.
  key_hash text not null check (char_length(key_hash) = 64),
  -- The normalized pharmacy text the AI was shown: name | address | governorate/area text
  -- (customerPharmacyKey in src/lib/sales/normalizer/customer-normalize.ts).
  pharmacy_key text not null check (char_length(pharmacy_key) between 1 and 4000),
  -- The model that answered. A model change asks again rather than reading another model's answer.
  model text not null check (char_length(model) between 1 and 200),
  -- The brick the AI named. Checked against the live brick master every time it is read.
  brick_id text not null check (char_length(brick_id) between 1 and 100),
  answered_at timestamptz not null default now(),
  primary key (key_hash, model)
);

alter table public.source_of_sales_customer_ai_answers enable row level security;

-- No policies, and no browser grants: only the server (service role) reads or writes this table.
-- Revoked explicitly because Supabase's default privileges grant anon and authenticated on every
-- new public table.
revoke all on table public.source_of_sales_customer_ai_answers from public, anon, authenticated;
grant select, insert, update, delete on table public.source_of_sales_customer_ai_answers to service_role;

comment on table public.source_of_sales_customer_ai_answers is
  'The brick the customer AI named for each distinct pharmacy text, per model, so the monthly normalizer never pays twice for the same question. Written and read only by src/lib/sales/normalizer/customer-ai-answers.ts; read after the free matching steps, so the customer map always wins.';

commit;
