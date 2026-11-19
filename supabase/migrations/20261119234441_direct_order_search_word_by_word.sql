-- direct_order_search_word_by_word
--
-- WHAT THIS CHANGES: the Direct Orders customer search (public.phx_search_direct_order_customers)
-- matches a typed NAME word by word. Every word the rep types must appear somewhere in the
-- Arabic-normalised name, in any order, and the generic words "pharmacy" / "doctor" (صيدلية,
-- صيدليه, الصيدلية, صيدليات, ص, د, دكتور, دكتورة, pharmacy, dr) are left out of the match.
-- Code matching, the short-probe fast path, the ranking and the limit are unchanged.
-- Each typed word also drops a leading "ال" (when 2+ letters remain), so "صيدلية الرياض" finds
-- a name stored as "رياض طهطا ن" (owner, 19 Nov 2026: "make the search easy" — hamza on alef,
-- the two forms of ya and "ال"). Hamza, ya, taa marbuta and tashkeel were already folded by
-- phx_normalize_arabic on both sides; that function is NOT changed, because the trigram index
-- is built on it and a changed body would leave the index silently stale.
--
-- WHY (owner, 19 Nov 2026: "why when Mohamed Ramadan is searching by name they do not appear but
-- by code they appear"). The name test was "the whole typed text, spaces removed, is one unbroken
-- piece of the name". The distributor names are bare — "رياض طهطا ن", "خالد عبدالرحيم-قوص ن م" — so
-- typing the word "pharmacy" first ("صيدلية رياض", "صيدلية خالد عبدالرحيم") found NOTHING, and so
-- did words in another order ("طهطا رياض"). Measured on production the same day: those three
-- probes returned 0 rows; "رياض طهطا" and the two codes found both pharmacies.
--
-- WHY THE OLD ANSWERS ARE KEPT. The new name test is a superset of the old one: a name that
-- contained the whole normalised probe contains every piece of it, because phx_normalize_arabic
-- works one character at a time. So no search that found a pharmacy before can lose it now. A
-- probe made ONLY of generic words ("صيدلية") falls back to the old whole-text test, so it still
-- finds the names that carry that word.
--
-- THE LIMIT CANNOT HIDE AN OLD ANSWER EITHER. Every hit carries `old_match` (the code contains the
-- typed text, or the name contains the whole normalised probe, i.e. the old test) and it is the
-- FIRST key of the ORDER BY, ahead of "Phoenix pharmacies first". Every row the old function
-- returned is an old_match row, and among them the old keys run in the old order, so the first
-- N rows now always hold the old first N; the rows only the word-by-word match adds come after.
-- Without it "صيدلية محمد" (3 names hold that text, 18,173 hold "محمد", dozens of them Phoenix
-- pharmacies that always rank first) pushed its real answers out of the first 30.
-- It costs nothing for a plain one-word probe (`lead = norm`, so it is the constant true).
--
-- SPEED (measured on production, 19 Nov 2026, generic plan as a SQL function gets it). The
-- directory arm is SPLIT by word count; the two arms are disjoint, so no row comes back twice.
--   * One word: `normalize(name) ilike '%lead%'` with nothing else beside it, so the whole test
--     collapses into the trigram bitmap's recheck and the plpgsql normaliser runs ONCE per row —
--     exactly the old work ("محمد", 18,173 rows: 309–322 ms, the old function 318 ms). Do not put
--     `p.norm is not null and` back in front of it: the planner can no longer prove it from an
--     ilike on `p.lead`, adds a Filter that repeats the whole OR, and the normaliser runs twice
--     per row (688–880 ms in the drafts of this file).
--   * Two or more words: the two LONGEST words are both index conditions, so the GIN index ANDs
--     their trigrams ("محمد علي" 54 ms for 891 rows); `ilike all` over the array (which no GIN
--     index can use) is only the re-check for a third word and beyond. The words are split on spaces and punctuation, so the
-- patterns never carry a % _ or \ of the rep's (the old path passed them through as wildcards).
--
-- ROLLBACK: `create or replace` the function with the body in
-- 20261016210000_direct_order_search_short_probe_fast_path.sql (section 3). Nothing else depends on
-- the new shape; no table, index or grant is touched.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- This migration replaces one read-only function and writes no data.

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
        || case when p0.norm is not null then array['n:' || lower(p0.norm)] else array[]::text[] end as keys,
      coalesce(w.lead, p0.norm)                        as lead,
      coalesce(w.patterns, array['%' || p0.norm || '%']) as patterns
    from probe p0
    left join lateral (
      select
        (array_agg(t.word order by char_length(t.word) desc, t.word))[1] as lead,
        array_agg('%' || t.word || '%' order by char_length(t.word) desc, t.word) as patterns
      from (
        select case when n.w like U&'\0627\0644%' and char_length(n.w) >= 4
                    then substr(n.w, 3) else n.w end as word
        from regexp_split_to_table(p0.raw, U&'[[:space:][:punct:]\060C\061B]+') as piece
        cross join lateral (select public.phx_normalize_arabic(piece) as w) n
      ) t
      where t.word is not null
        and t.word <> all (array['صيدليه', 'الصيدليه', 'صيدليات', 'ص', 'د', 'دكتور', 'دكتوره', 'pharmacy', 'dr'])
    ) w on true
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
      (m.customer_code ilike p.raw || '%')   as prefix_code,
      case when p.lead = p.norm then true
           else (m.customer_code ilike '%' || p.raw || '%'
                 or public.phx_normalize_arabic(m.customer_name) ilike '%' || p.norm || '%') end as old_match
    from public.source_of_sales_customer_map m, probe_kind p
    where m.active
      and p.raw <> ''
      and not p.short_probe
      and cardinality(p.patterns) <= 1
      and (p_distributor_code is null or m.distributor_code = p_distributor_code)
      and (
        m.customer_code ilike p.raw || '%'
        or m.customer_code ilike '%' || p.raw || '%'
        or public.phx_normalize_arabic(m.customer_name) ilike '%' || p.lead || '%'
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
      (m.customer_code ilike p.raw || '%')   as prefix_code,
      (m.customer_code ilike '%' || p.raw || '%'
       or public.phx_normalize_arabic(m.customer_name) ilike '%' || p.norm || '%') as old_match
    from public.source_of_sales_customer_map m, probe_kind p
    where m.active
      and p.raw <> ''
      and not p.short_probe
      and cardinality(p.patterns) > 1
      and (p_distributor_code is null or m.distributor_code = p_distributor_code)
      and (
        m.customer_code ilike p.raw || '%'
        or m.customer_code ilike '%' || p.raw || '%'
        or (public.phx_normalize_arabic(m.customer_name) ilike p.patterns[1]
            and public.phx_normalize_arabic(m.customer_name) ilike p.patterns[2]
            and (cardinality(p.patterns) = 2
                 or public.phx_normalize_arabic(m.customer_name) ilike all (p.patterns)))
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
      (m.customer_code ilike p.raw || '%')   as prefix_code,
      true                                   as old_match
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
      (c.customer_code ilike p.raw || '%')   as prefix_code,
      coalesce(c.customer_code ilike '%' || p.raw || '%'
               or ph.phoenix_pharmacy_code ilike '%' || p.raw || '%'
               or public.phx_normalize_arabic(ph.pharmacy_name) ilike '%' || p.norm || '%', false) as old_match
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
            and public.phx_normalize_arabic(ph.pharmacy_name) ilike all (p.patterns))
      )
  )
  select h.source, h.distributor_code, h.customer_code, h.customer_name, h.address,
         h.brick_id, h.area_code, h.region_code, h.phoenix_pharmacy_code, h.verification_status
  from hits h
  order by
    h.old_match desc nulls last,
    (h.source = 'phoenix') desc,
    h.exact_code desc nulls last,
    h.prefix_code desc nulls last,
    (h.customer_name is not null) desc,
    h.customer_name asc nulls last,
    h.customer_code asc nulls last
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$function$;

comment on function public.phx_search_direct_order_customers(text, text, integer) is
  'Direct Orders customer picker. Matches the customer code (prefix, then contains) or the name word by '
  'word: every typed word, Arabic-normalised, anywhere in the normalised name, in any order, with the '
  'generic words pharmacy/doctor left out and a leading al- dropped. A 1-2 character probe is answered from '
  'source_of_sales_customer_map_search_keys_idx. SECURITY INVOKER: callers reach it with the service role.';
