-- move_pg_trgm_to_extensions_and_pin_scratch_search_path
--
-- WHAT THIS CHANGES:
--   1. Moves the pg_trgm extension from `public` to `extensions` (Supabase's schema for them),
--      clearing the advisor's `extension_in_public` warning.
--   2. Rewrites public.phx_suggest_direct_order_pharmacies — the direct-order pharmacy
--      suggester — to call `extensions.similarity(...)`. It carries `search_path=""` and called
--      `public.similarity(...)` schema-qualified, which is why the move was refused on
--      2026-09-30 (20260929215727_phase4_schema_hygiene.sql, item 5): moving the extension alone
--      would break it at its next call. Both now happen in one transaction. Same signature, same
--      return shape, same grants (`create or replace` keeps them); only the qualifier changes.
--   3. Pins the search_path of zz_search_proof.run_phase, a scratch function from a search-speed
--      proof that the advisor reads as `function_search_path_mutable`. Every name in its body is
--      already schema-qualified, so pinning changes nothing it resolves. Guarded: the schema
--      exists on production only.
-- WHY: the 23 Oct 2026 health check listed these as open database security warnings.
--   Measured on production before writing (23 Oct, ~04:30 Cairo): the only body in the whole
--   database that names a pg_trgm function or operator is the suggester (a scan for similarity,
--   word_similarity, show_trgm, set_limit, the <-> family and OPERATOR(...) found nothing else;
--   every ` % ` found was integer modulo). No view names one. The two trigram indexes on
--   source_of_sales_customer_map bind to the opclass by OID and survive the move. anon,
--   authenticated, service_role and postgres all hold USAGE on `extensions`.
-- STAGING: pg_trgm is in public there too, with the same suggester and both indexes; the
--   zz_search_proof block skips itself.
-- ROLLBACK: `alter extension pg_trgm set schema public;` then re-apply the suggester body from
--   20260805034500_direct_order_pharmacy_suggestions.sql (public.similarity). For item 3:
--   `alter function zz_search_proof.run_phase(text, integer) reset search_path;`.
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Anything destructive or bulk is announced to the owner in plain words BEFORE it is applied.
-- Nothing here is either: no row is read, written or deleted.

begin;

create schema if not exists extensions;

alter extension pg_trgm set schema extensions;

create or replace function public.phx_suggest_direct_order_pharmacies(
  p_name text,
  p_min_score numeric default 0.35,
  p_limit int default 5
)
returns table (
  distributor_code text,
  customer_code text,
  customer_name text,
  address text,
  brick_id text,
  area_code text,
  region_code text,
  score numeric
)
language sql
stable
security invoker
set search_path = ''
as $$
  with probe as (select public.phx_normalize_arabic(p_name) as norm)
  select distinct on (m.distributor_code, m.customer_code)
         m.distributor_code, m.customer_code, m.customer_name, m.address,
         m.brick_id, m.area_code, m.region_code,
         round(extensions.similarity(public.phx_normalize_arabic(m.customer_name), p.norm)::numeric, 3) as score
  from public.source_of_sales_customer_map m, probe p
  where m.active
    and p.norm is not null
    and m.customer_name is not null
    -- A nameless customer cannot be suggested BY NAME: offering a bare code as "did you mean"
    -- gives the rep nothing to recognise, and a suggestion they cannot judge is noise.
    and btrim(m.customer_name) <> ''
    and extensions.similarity(public.phx_normalize_arabic(m.customer_name), p.norm) >= coalesce(p_min_score, 0.35)
  order by m.distributor_code, m.customer_code, score desc
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

do $$
begin
  if to_regprocedure('zz_search_proof.run_phase(text, integer)') is not null then
    alter function zz_search_proof.run_phase(text, integer)
      set search_path = zz_search_proof, public, pg_temp;
  end if;
end
$$;

-- Refuse to commit a half-done move: the extension must be in `extensions` and the suggester
-- must no longer name `public.similarity`.
do $$
begin
  if (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm') <> 'extensions' then
    raise exception 'pg_trgm did not move to the extensions schema';
  end if;
  if exists (
    select 1 from pg_proc
    where proname = 'phx_suggest_direct_order_pharmacies'
      and pronamespace = 'public'::regnamespace
      and prosrc like '%public.similarity(%'
  ) then
    raise exception 'phx_suggest_direct_order_pharmacies still calls public.similarity';
  end if;
end
$$;

commit;
