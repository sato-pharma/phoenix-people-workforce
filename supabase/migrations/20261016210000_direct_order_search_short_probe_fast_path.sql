-- Direct orders: the customer search answers a short probe from an index instead of reading every row.
--
-- The picker types into public.phx_search_direct_order_customers, and a probe of one or two
-- characters (the second keystroke of a name, a two-digit code) took 2-5 seconds on production
-- (16 Oct 2026: '10' 1,959 ms, 'ab' 1,925 ms, 2 Arabic letters 2,083 ms; the function's worst call was
-- 5,316 ms and its mean 590 ms over 125 calls).
--
-- WHY. The search matches the customer CODE (contains) or the Arabic-normalized NAME (contains).
-- Both are trigram-indexed, and a trigram index needs at least three characters to narrow
-- anything: for '%10%' it hands back every row, so all 81,016 active rows were re-checked, each
-- calling phx_normalize_arabic (about 17 microseconds) and up to three ILIKEs. 2.3 s of the 2.5 s warm
-- run was that re-check, and a cold run also read ~1,100 index pages from disk.
--
-- TWO CHANGES, BOTH OUTPUT-IDENTICAL.
--
--   1. phx_normalize_arabic gets a cheaper body. Same text in, same text out, for every input:
--      the three letter-folding regexes become one translate() over the seven letters, and the
--      two removals (harakat/tatweel, then whitespace) become one regexp_replace over a single
--      class that keeps the original \s. Written as plpgsql so the call skips the SQL-function
--      executor start (about 3.5 microseconds a call). The index definitions are untouched: they
--      store the same values, so nothing is rebuilt.
--      Proof run on production before this was written (16 Oct 2026): all 1,112,063 code points
--      compared one by one, 162,384 real names/codes/addresses, 185,193 synthetic strings built
--      from the folded letters, the marks, the whitespace and the case-sensitive oddities: 0 differences.
--
--   2. A short probe is answered from a GIN index of every 1- and 2-character piece of each
--      customer's lower-cased code and of its normalized name (phx_direct_order_search_keys).
--      A probe of one or two plain characters (digits, ASCII letters, the Arabic letters at
--      U+0621..U+064A) looks those pieces up directly. Longer probes, and any probe with another character
--      (a wildcard % _ \, a dash, a slash, a space), take the existing trigram path, unchanged.
--      Why the answer is identical: ILIKE '%x%' lower-cases the text and the pattern and then
--      looks for x as a substring; for x of one or two characters from that alphabet lower() is
--      character-by-character, so "lower(code) contains lower(x)" is "lower(code) has lower(x)
--      among its 1- and 2-character pieces", which is what the index holds.
--
-- ROLLBACK. Reverse is `create or replace` with the bodies in 20260807120000 (the normalizer) and
-- 20260804183000 (the search), then `drop index ... source_of_sales_customer_map_search_keys_idx`
-- and `drop function ... phx_direct_order_search_keys`. Nothing else depends on the new objects.

-- == 1. A cheaper phx_normalize_arabic, same output ==========================
-- Folds: alef family 0623 0625 0622 0671 -> 0627, ta-marbuta 0629 -> 0647, alef-maqsura 0649 and
-- ya-hamza 0626 -> 064A. Removes: harakat 064B..0652, superscript alef 0670, tatweel 0640 and every
-- \s. The class is deliberately NOT widened: a range that reaches the letters at 0621..063A reduces
-- a probe to the empty string and the search then matches every row while looking like it works.
-- The class below is written with codepoint escapes (U&'...'), and the seven fold letters in
-- translate() pair with their targets by position -- the first four map to 0627, then 0647, then
-- 064A twice.
create or replace function public.phx_normalize_arabic(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  return nullif(
    translate(
      regexp_replace(
        lower(coalesce(p_text, '')),
        U&'[\\s\064B-\0652\0670\0640]+', '', 'g'
      ),
      U&'\0623\0625\0622\0671\0629\0649\0626',
      U&'\0627\0627\0627\0627\0647\064A\064A'
    ),
    ''
  );
end;
$$;

-- == 2. The 1- and 2-character pieces a short probe looks up ===================
-- 'c:' pieces come from lower(customer_code), 'n:' pieces from lower(phx_normalize_arabic(name)),
-- exactly the strings the search's ILIKEs look inside. One- and two-character pieces only.
create or replace function public.phx_direct_order_search_keys(p_code text, p_name text)
returns text[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text;
  n int;
  i int;
  keys text[] := '{}';
begin
  s := lower(p_code);
  n := coalesce(char_length(s), 0);
  for i in 1..n loop
    keys := keys || ('c:' || substr(s, i, 1));
    if i < n then
      keys := keys || ('c:' || substr(s, i, 2));
    end if;
  end loop;

  s := lower(public.phx_normalize_arabic(p_name));
  n := coalesce(char_length(s), 0);
  for i in 1..n loop
    keys := keys || ('n:' || substr(s, i, 1));
    if i < n then
      keys := keys || ('n:' || substr(s, i, 2));
    end if;
  end loop;

  return keys;
end;
$$;

-- This project's default ACL hands a new public-schema function to anon and authenticated as well,
-- and REVOKE FROM PUBLIC does not touch those two, so they are named.
revoke all on function public.phx_direct_order_search_keys(text, text) from public, anon, authenticated;
grant execute on function public.phx_direct_order_search_keys(text, text) to service_role;

comment on function public.phx_direct_order_search_keys(text, text) is
  'Every 1- and 2-character piece of lower(customer_code) (prefix c:) and of the normalized, lower-cased '
  'name (prefix n:). IMMUTABLE index key for phx_search_direct_order_customers; a probe of one or two plain '
  'characters is looked up here instead of re-checking every row.';

-- Small index over short keys; bound lock acquisition and execution so a busy production table
-- fails safe instead of blocking imports indefinitely. Same partial predicate as its trigram siblings.
set lock_timeout = '5s';
set statement_timeout = '120s';

create index if not exists source_of_sales_customer_map_search_keys_idx
  on public.source_of_sales_customer_map
  using gin (public.phx_direct_order_search_keys(customer_code, customer_name))
  where active;

reset statement_timeout;
reset lock_timeout;

-- == 3. The search: the same rows, a short probe answered from the index ========
-- Only two things differ from the definition in 20260804183000_direct_order_customer_directory_search.sql:
--   * `probe_kind` wraps `probe` and adds the short-probe flag and the lookup keys;
--   * the directory half becomes two halves: the existing predicate for any other probe (its text
--     is unchanged, plus `not p.short_probe`), and the index lookup for a short one.
-- The phoenix half, the ranking and the limit are untouched.
create or replace function public.phx_search_direct_order_customers(
  p_query text,
  p_distributor_code text default null,
  p_limit integer default 30
)
returns table(
  source text,
  distributor_code text,
  customer_code text,
  customer_name text,
  address text,
  brick_id text,
  area_code text,
  region_code text,
  phoenix_pharmacy_code text,
  verification_status text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with probe as (
    select
      btrim(coalesce(p_query, ''))         as raw,
      public.phx_normalize_arabic(p_query) as norm
  ),
  probe_kind as (
    select
      p0.raw,
      p0.norm,
      (p0.raw ~ U&'^[0-9A-Za-z\0621-\064A]{1,2}$') as short_probe,
      array['c:' || lower(p0.raw)]
        || case when p0.norm is not null then array['n:' || lower(p0.norm)] else array[]::text[] end as keys
    from probe p0
  ),
  hits as (
    select
      'directory'::text     as source,
      m.distributor_code,
      m.customer_code,
      m.customer_name,
      m.address,
      m.brick_id,
      m.area_code,
      m.region_code,
      null::text            as phoenix_pharmacy_code,
      null::text            as verification_status,
      (m.customer_code = p.raw)              as exact_code,
      (m.customer_code ilike p.raw || '%')   as prefix_code
    from public.source_of_sales_customer_map m, probe_kind p
    where m.active
      and p.raw <> ''
      and not p.short_probe
      and (p_distributor_code is null or m.distributor_code = p_distributor_code)
      and (
        m.customer_code ilike p.raw || '%'
        or m.customer_code ilike '%' || p.raw || '%'
        or (p.norm is not null
            and public.phx_normalize_arabic(m.customer_name) ilike '%' || p.norm || '%')
      )

    union all

    select
      'directory'::text     as source,
      m.distributor_code,
      m.customer_code,
      m.customer_name,
      m.address,
      m.brick_id,
      m.area_code,
      m.region_code,
      null::text            as phoenix_pharmacy_code,
      null::text            as verification_status,
      (m.customer_code = p.raw)              as exact_code,
      (m.customer_code ilike p.raw || '%')   as prefix_code
    from public.source_of_sales_customer_map m, probe_kind p
    where m.active
      and p.raw <> ''
      and p.short_probe
      and (p_distributor_code is null or m.distributor_code = p_distributor_code)
      and public.phx_direct_order_search_keys(m.customer_code, m.customer_name) && p.keys

    union all

    select
      'phoenix'::text       as source,
      c.distributor_code,
      c.customer_code,
      ph.pharmacy_name      as customer_name,
      ph.pharmacy_address   as address,
      coalesce(c.mapped_brick_id,  ph.brick_id)   as brick_id,
      coalesce(c.mapped_area_code, ph.area_code)  as area_code,
      coalesce(c.mapped_region_code, ph.region_code) as region_code,
      ph.phoenix_pharmacy_code,
      ph.verification_status,
      (c.customer_code = p.raw)              as exact_code,
      (c.customer_code ilike p.raw || '%')   as prefix_code
    from public.direct_order_pharmacies ph
    left join public.direct_order_pharmacy_distributor_codes c on c.pharmacy_id = ph.id
    cross join probe_kind p
    where ph.active
      and p.raw <> ''
      and (p_distributor_code is null or c.distributor_code = p_distributor_code)
      and (
        c.customer_code ilike p.raw || '%'
        or c.customer_code ilike '%' || p.raw || '%'
        or ph.phoenix_pharmacy_code ilike '%' || p.raw || '%'
        or (p.norm is not null
            and public.phx_normalize_arabic(ph.pharmacy_name) ilike '%' || p.norm || '%')
      )
  )
  select h.source, h.distributor_code, h.customer_code, h.customer_name, h.address,
         h.brick_id, h.area_code, h.region_code, h.phoenix_pharmacy_code, h.verification_status
  from hits h
  order by
    (h.source = 'phoenix') desc,
    h.exact_code desc nulls last,
    h.prefix_code desc nulls last,
    (h.customer_name is not null) desc,
    h.customer_name asc nulls last,
    h.customer_code asc nulls last
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$function$;
