-- A saved customer mapping now keeps the pharmacy's name and address - filling blanks only.
--
-- WHAT WENT WRONG. saveMappings (src/lib/sales/normalizer/mapping.ts) upserts a customer mapping as
-- the key, the brick and its provenance, and nothing else, so every mapping made on the normalizer,
-- by Auto-map or from the upload screen landed with no name and no address. Measured on production
-- 2026-09-18: 2,484 normalizer rows and 69 auto rows have neither. The free steps learn only from
-- mappings that carry a name or an address, so each nameless mapping was a pharmacy they could not
-- learn from.
--
-- WHY NOT JUST PUT THEM IN THE UPSERT. The upsert is ON CONFLICT DO UPDATE, so a name in it would
-- OVERWRITE the name already on file - and one distributor code can name different pharmacies over
-- time (EP-PHS reuses codes), so the newest sheet must never replace a name that is already there.
-- supabase-js also sends one column list for a whole bulk upsert, so a row without a name would null
-- out an existing one. The name therefore travels separately, through this function, which writes a
-- name or address ONLY where the stored one is blank (NULL or whitespace).
--
-- Matching is exact on (distributor_code, customer_code) - the same values the upsert just wrote,
-- which is the table's conflict key. Only customer_name and address are ever written: never the
-- brick, area, region, source, confidence or active flag, so the mapping guard's move check
-- (sos_map_guard_customer) is never engaged by it.

begin;

create or replace function public.sos_customer_map_fill_blanks(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer := 0;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    return 0;
  end if;

  with incoming as (
    -- One candidate per key; a row that carries a value wins over one that does not.
    select distinct on (x.distributor_code, x.customer_code)
           x.distributor_code,
           x.customer_code,
           nullif(btrim(x.customer_name), '') as customer_name,
           nullif(btrim(x.address), '') as address
    from jsonb_to_recordset(p_rows)
           as x(distributor_code text, customer_code text, customer_name text, address text)
    where x.distributor_code is not null
      and x.customer_code is not null
    order by x.distributor_code,
             x.customer_code,
             (nullif(btrim(x.customer_name), '') is null),
             (nullif(btrim(x.address), '') is null)
  ),
  filled as (
    update public.source_of_sales_customer_map m
    set customer_name = case when nullif(btrim(m.customer_name), '') is null
                             then coalesce(i.customer_name, m.customer_name)
                             else m.customer_name end,
        address       = case when nullif(btrim(m.address), '') is null
                             then coalesce(i.address, m.address)
                             else m.address end
    from incoming i
    where m.distributor_code = i.distributor_code
      and m.customer_code = i.customer_code
      and (   (nullif(btrim(m.customer_name), '') is null and i.customer_name is not null)
           or (nullif(btrim(m.address), '') is null and i.address is not null))
    returning m.id
  )
  select count(*)::integer into v_count from filled;

  return v_count;
end;
$function$;

comment on function public.sos_customer_map_fill_blanks(jsonb) is
  'Fills a customer mapping''s blank customer_name / address from [{distributor_code, customer_code, customer_name, address}], matched exactly on the conflict key. Never overwrites a stored value and never touches the brick, area, region, source, confidence or active flag. Returns the number of mappings that gained a name or an address.';

revoke execute on function public.sos_customer_map_fill_blanks(jsonb)
  from public, anon, authenticated;
grant execute on function public.sos_customer_map_fill_blanks(jsonb)
  to service_role;

commit;
