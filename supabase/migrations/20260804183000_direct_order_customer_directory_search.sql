-- Direct orders: searchable customer directory for the submit form.
--
-- Owner report, 2026-08-04 (the module's first day with real staff on it): "no more anyone enters
-- pharmacy name or pharmacy code -- make it a combo box, he types, he finds it, he chooses, and
-- the system validates the area."
--
-- Reps were hand-typing because searching genuinely did not work. Two defects, both measured
-- against production before this migration was written:
--
--   1. The search ran a raw ILIKE on `customer_name`. Egyptian pharmacy names are written with
--      inconsistent orthography (ta-marbuta vs ha, the hamza forms of alef, alef-maqsura vs ya,
--      stray harakat), so the typed form rarely matches the stored form. Probing the catalogue
--      with one common word: raw ILIKE returned 4 rows where the normalized comparison below
--      returned 11 -- it was missing 64% of the real matches.
--   2. It searched the NAME only, and then dropped every row whose name was null. 6,089 of the
--      51,192 rows have no name at all, so those customers were unreachable by any query -- even
--      when the rep is holding the distributor's own code for exactly that customer.
--
-- Hence: normalize both sides, and match on the code as well as the name. A customer with no name
-- is returned rather than hidden -- the caller renders it as its code with "(no name on file)", so
-- a missing name reads as missing rather than as "does not exist".
--
-- EVERY Arabic character below is written as a codepoint escape (\uXXXX inside a regex class,
-- U&'\XXXX' for a replacement literal) and never as a literal glyph. Editing literal Arabic in a
-- mixed LTR/RTL source file is not safe: the visual order is not the byte order, and an earlier
-- draft of this file silently mispaired the waw-hamza and ya-hamza folds because of it.

-- == Orthographic normalization =============================================
-- Folds the letter forms that vary in practice, then strips the combining marks. IMMUTABLE so it
-- can back an index.
create or replace function public.phx_normalize_arabic(p_text text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              lower(coalesce(p_text, '')),
              -- alef family: hamza-above (0623), hamza-below (0625), madda (0622),
              -- wasla (0671)  ->  plain alef (0627)
              '[أإآٱ]', U&'\0627', 'g'
            ),
            -- ta-marbuta (0629) -> ha (0647); these are interchanged constantly word-finally
            '[ة]', U&'\0647', 'g'
          ),
          -- alef-maqsura (0649) and ya-hamza (0626) -> plain ya (064A)
          '[ىئ]', U&'\064A', 'g'
        ),
        -- harakat (064B..0652), superscript alef (0670) and tatweel (0640) are dropped entirely.
        -- Listed as an explicit narrow range: a wider one such as [ؐ-ً] swallows the
        -- Arabic LETTERS at 0621..063A, which reduced a probe to the empty string and made the
        -- search match all 51,192 rows while looking like it worked.
        '[ً-ْٰـ]+', '', 'g'
      )
    ),
    ''
  );
$$;

comment on function public.phx_normalize_arabic(text) is
  'Fold Arabic orthographic variants (alef family, ta-marbuta/ha, alef-maqsura/ya) and strip '
  'harakat/tatweel so a typed name matches a stored one. IMMUTABLE -- safe to index on.';

-- Keep the directory search fast at ~51k rows.
create index if not exists source_of_sales_customer_map_norm_name_idx
  on public.source_of_sales_customer_map (public.phx_normalize_arabic(customer_name) text_pattern_ops)
  where active;

create index if not exists source_of_sales_customer_map_code_idx
  on public.source_of_sales_customer_map (customer_code text_pattern_ops)
  where active;

-- == The directory search ===================================================
-- SECURITY INVOKER on purpose: this reads a catalogue the application already exposes through the
-- direct-orders service, and that service applies the caller's AREA scope on the way out. DEFINER
-- here would hand a company-wide customer list to whoever could reach the function.
-- Owner rule, 2026-08-04: "when any new pharmacy is added any way into Phoenix, the drop list is
-- updated." A pharmacy can be born down TWO disjoint paths, and neither writes the other's table:
--
--   * the SoS customer directory (`source_of_sales_customer_map`), loaded from the distributors;
--   * `direct_order_pharmacies`, written when someone registers a pharmacy in the registry screen
--     OR creates one inline while submitting an order.
--
-- Searching only the first would mean a pharmacy someone just registered in Phoenix is missing
-- from the very list that exists to stop people typing it by hand. So this UNIONs both, and reads
-- them live on each keystroke -- there is no materialized copy to go stale, which is the whole
-- point of the rule.
-- CREATE OR REPLACE cannot change a function's OUT columns, and this one gained `source`,
-- `phoenix_pharmacy_code` and `verification_status`. Drop first so re-running the migration is
-- not a "cannot change return type of existing function" failure.
drop function if exists public.phx_search_direct_order_customers(text, text, int);

create function public.phx_search_direct_order_customers(
  p_query text,
  p_distributor_code text default null,
  p_limit int default 30
)
returns table (
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
as $$
  with probe as (
    select
      btrim(coalesce(p_query, ''))         as raw,
      public.phx_normalize_arabic(p_query) as norm
  ),
  hits as (
    -- 1) the distributor customer directory
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
    from public.source_of_sales_customer_map m, probe p
    where m.active
      and p.raw <> ''
      and (p_distributor_code is null or m.distributor_code = p_distributor_code)
      and (
        m.customer_code ilike p.raw || '%'
        or m.customer_code ilike '%' || p.raw || '%'
        or (p.norm is not null
            and public.phx_normalize_arabic(m.customer_name) ilike '%' || p.norm || '%')
      )

    union all

    -- 2) pharmacies registered in Phoenix itself, with one row per distributor code they carry.
    --    LEFT JOIN, not JOIN: a pharmacy registered without any distributor code must still be
    --    findable by name -- dropping it here is exactly the "added but not in the list" failure
    --    this rule exists to prevent.
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
    cross join probe p
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
    -- a pharmacy Phoenix already knows outranks a raw directory row for the same typing
    (h.source = 'phoenix') desc,
    h.exact_code desc nulls last,
    h.prefix_code desc nulls last,
    (h.customer_name is not null) desc,
    h.customer_name asc nulls last,
    h.customer_code asc nulls last
  limit least(greatest(coalesce(p_limit, 30), 1), 100);
$$;

comment on function public.phx_search_direct_order_customers(text, text, int) is
  'Type-ahead over the SoS customer directory for the direct-order form. Matches customer_code '
  '(prefix, then contains) OR the Arabic-normalized customer_name. Unnamed customers ARE returned '
  '-- the caller labels them "(no name on file)" rather than hiding them. The direct-orders '
  'service applies the caller''s area scope to these rows; this function does not.';

-- The app reads through the service-role client; keep anon/authenticated off it entirely so the
-- customer catalogue can never be enumerated straight from the browser. REVOKE FROM PUBLIC strips
-- service_role too when it only held the default ACL, so the GRANTs below are not optional.
revoke all on function public.phx_search_direct_order_customers(text, text, int) from public;
revoke all on function public.phx_normalize_arabic(text) from public;
grant execute on function public.phx_normalize_arabic(text) to service_role;
grant execute on function public.phx_search_direct_order_customers(text, text, int) to service_role;
