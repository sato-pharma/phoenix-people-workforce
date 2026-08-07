-- Follow-up to 20260807120000_direct_order_search_arabic_space_fold.sql.
--
-- phx_normalize_arabic is IMMUTABLE and backs two expression indexes. Replacing the function
-- does not recompute either index. The parent migration rebuilt the B-tree prefix index but
-- omitted this partial GIN trigram index, leaving its stored keys on the old space-preserving
-- normalization. Keep this as a separate migration because the parent was already applied to
-- production before the missing dependency was identified in review.
--
-- This index is small (3.2 MB over 52,510 production rows when inspected on 2026-08-07), so a
-- normal REINDEX is appropriate for the migration transaction. Bound both lock acquisition and
-- execution so a busy production table fails safely instead of waiting indefinitely.
set lock_timeout = '5s';
set statement_timeout = '30s';

reindex index public.source_of_sales_customer_map_name_trgm_idx;

reset statement_timeout;
reset lock_timeout;
