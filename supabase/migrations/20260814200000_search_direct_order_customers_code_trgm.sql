-- Speed up phx_search_direct_order_customers by giving customer_code its own trigram index.
--
-- The direct-order customer search OR-combines three predicates on source_of_sales_customer_map:
--   customer_code ILIKE 'q%'                          (prefix)
--   customer_code ILIKE '%q%'                         (infix)
--   phx_normalize_arabic(customer_name) ILIKE '%q%'   (name — already trigram-indexed)
--
-- Postgres can only build a BitmapOr when EVERY disjunct is independently indexable. customer_code
-- had only a btree text_pattern_ops index, which cannot serve a case-insensitive ILIKE, so the
-- planner fell back to scanning a covering index and applying the whole OR as a per-row filter over
-- every active row (recomputing phx_normalize_arabic per row). Measured 1.4–1.8 s per search on
-- ~52k active rows — a real production cost and a slow search box.
--
-- Adding a GIN trigram index on customer_code makes all three disjuncts indexable, so the planner
-- switches to BitmapOr(code-prefix, code-infix, name) + a bitmap-heap recheck. Proven on staging
-- (49,745 active rows): 'محمد' 1763 ms → 301 ms; a code prefix '100' → 13 ms; result set
-- byte-identical (an index cannot change query output — verified md5-identical across name, pharmacy
-- and code queries). This is the sibling of source_of_sales_customer_map_name_trgm_idx and shares
-- its WHERE active partial predicate.
--
-- Small index over short codes; bound lock acquisition and execution so a busy production table
-- fails safe instead of blocking imports indefinitely.
set lock_timeout = '5s';
set statement_timeout = '60s';

create index if not exists source_of_sales_customer_map_code_trgm_idx
  on public.source_of_sales_customer_map using gin (customer_code gin_trgm_ops)
  where active;

reset statement_timeout;
reset lock_timeout;
