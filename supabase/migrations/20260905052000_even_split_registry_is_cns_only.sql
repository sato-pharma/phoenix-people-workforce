-- The even-split registry is CNS only — the owner's rule, stated again on 2026-09-05:
-- "and the ez rule for cns only".
--
-- WHY A CONSTRAINT AND NOT A NOTE. Until now nothing enforced it. The table's primary key is
-- (client_code, official_line), which does not merely permit a second line for the same customer —
-- it is the shape that INVITES one. A single INSERT would have put EZ on Pedia or Anti Infective,
-- and everything downstream would have obeyed without a word: phx_sos_rows_attributed would spread
-- that line's units across a Cairo/Giza roster built for CNS, the fact rollup would carry it, and
-- the closing would show it. No error, no marker, and the rule would read as broken by the system
-- rather than by the row.
--
-- The registry is data-only: nothing in the application writes this table (verified 2026-09-05),
-- so it changes by migration or by hand — which is exactly the setting where a typed line name
-- goes unreviewed. A constraint is the only reader that is always present.
--
-- EXACT EQUALITY, deliberately, not upper(btrim(...)). phx_sos_rows_attributed matches the registry
-- with `upper(c.official_line) = upper(btrim(base.official_line))` — it folds case on both sides but
-- trims only the SALES side. So a registry row spelled ' CNS ' would satisfy a tolerant check and
-- then match nothing at all, which is the silent-no-op this guard exists to prevent. Requiring the
-- literal 'CNS' makes the stored value and the matched value the same string.
--
-- TO LIFT IT, if the owner ever wants an even split on another line, this is one deliberate
-- statement — which is the point:
--   alter table public.sos_even_split_customers drop constraint sos_even_split_customers_cns_only;
--
-- Nothing already stored is touched. The table holds one row (1011654 / CNS, active), and Pedia's
-- and Anti Infective's history is unaffected because neither ever had an entry.

do $$
declare
  offending integer;
begin
  -- Fail loudly rather than half-applying. A row that would violate the rule is a business question
  -- for the owner, not something a migration may quietly delete or rewrite.
  select count(*) into offending
  from public.sos_even_split_customers
  where official_line is distinct from 'CNS';

  if offending > 0 then
    raise exception
      'sos_even_split_customers holds % row(s) whose official_line is not CNS. '
      'Resolve them with the owner before applying this constraint.', offending;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.sos_even_split_customers'::regclass
      and conname = 'sos_even_split_customers_cns_only'
  ) then
    alter table public.sos_even_split_customers
      add constraint sos_even_split_customers_cns_only
      check (official_line = 'CNS');
  end if;
end
$$;

comment on constraint sos_even_split_customers_cns_only on public.sos_even_split_customers is
  'Owner rule, 2026-09-05: the even-split rule is CNS only. The (client_code, official_line) key '
  'would otherwise accept a second line for the same customer, and every downstream step would '
  'honour it silently. Drop this constraint deliberately if that rule ever changes.';
