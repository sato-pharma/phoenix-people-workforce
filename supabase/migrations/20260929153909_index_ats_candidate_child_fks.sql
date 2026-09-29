-- Cover the two foreign keys into ats_candidates whose child tables are big enough for the
-- absence to cost something.
--
-- Supabase's performance advisor reports 32 unindexed foreign keys on this database. Twenty-six
-- of them are on tables of 0-8 KB, where a sequential scan is a single page read and an index
-- would be slower to maintain than the scan it replaces — and this database already carries 654
-- never-scanned indexes holding 239 MB, so adding indexes nothing will use is the problem, not
-- the fix. Four sit on tables large enough to matter, and of those only these two have a parent
-- that is actually deleted from.
--
-- WHAT DECIDES IT is the parent's delete count, not the child's size. An unindexed FK costs
-- nothing until a parent row is deleted or its key updated, because that is when Postgres scans
-- the child to enforce the constraint. Measured on production 2026-09-29 (pg_stat_user_tables):
--
--     ats_candidates          11 deletes, 200 updates   -> both children indexed here
--     source_of_sales_bricks   0 deletes,   0 updates   -> skipped
--     sos_map_change_log       0 deletes,   0 updates   -> skipped (append-only log)
--
-- source_of_sales_customer_map's (brick_id, area_code, region_code) FK is the largest child at
-- 16 MB and 77k rows, and it is deliberately NOT indexed here: bricks are never deleted (owner
-- rule) and supersession is a soft flag, so the check never fires, and pg_stat_statements shows
-- no query filtering that table by brick_id that is slow — the busiest one runs in 7.7 ms on an
-- existing index. An index there would be the 655th nobody reads.
--
-- WHY PARTIAL. Both columns are mostly NULL (1,122 of 13,373 messages; 628 of 887
-- conversations), and a NULL can never match a foreign key. Excluding them keeps the indexes at
-- 48 kB and 40 kB instead of indexing rows the constraint can never look at. The planner uses a
-- partial index for the RI check because `col = $1` implies `col IS NOT NULL` — verified on
-- production with EXPLAIN ANALYZE rather than assumed:
--
--     Index Scan using whatsapp_inbox_messages_saved_candidate_idx
--       Index Cond: (saved_to_candidate_id = ...)
--       Buffers: shared hit=4        (against a 10 MB / ~1,286-page sequential scan)
--
-- ALREADY LIVE ON PRODUCTION. Both were created there with CREATE INDEX CONCURRENTLY, so the
-- write locks a plain CREATE INDEX takes never landed on a table that receives WhatsApp
-- webhooks. CONCURRENTLY cannot run inside a transaction and migrations do, so the statements
-- below are the plain form guarded by IF NOT EXISTS: a no-op on production, and correct for
-- staging and for any database rebuilt from migrations, where there is no traffic to block.

create index if not exists whatsapp_inbox_messages_saved_candidate_idx
  on public.whatsapp_inbox_messages (saved_to_candidate_id)
  where saved_to_candidate_id is not null;

create index if not exists whatsapp_inbox_conversations_candidate_idx
  on public.whatsapp_inbox_conversations (candidate_id)
  where candidate_id is not null;
