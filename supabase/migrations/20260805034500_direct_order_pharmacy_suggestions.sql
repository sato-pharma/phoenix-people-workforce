-- "Did you mean…" for the pharmacy combo box (spec B4 — docs/specs/direct-orders-v2.md).
--
-- WHY THIS IS NOT AN AI CALL.
--
-- The spec listed this under the AI work, and a model would do a decent job. Trigram similarity
-- does a better one HERE, for a reason specific to what this feature is for: the suggestion is
-- evidence. When a rep is shown "did you mean الهداية (EGD 143612)?" and clicks past it to claim a
-- new pharmacy, that refusal is recorded and may later be the difference between a mistake and a
-- pattern. Evidence produced by a deterministic function is defensible — the same typing always
-- yields the same suggestions, today and in six months. Evidence produced by a model that may
-- answer differently tomorrow is not.
--
-- It is also simply better engineering here: no per-keystroke latency, no API cost, no failure
-- mode when the provider is rate-limited (which is exactly what happened to email tonight), and
-- nothing to hide from users under the invisible-AI rule.
--
-- Measured on production data before writing this: typing 'الهدا' (wrong final letter) scores
-- 0.556 against 'الهداية' and 0.500 against 'الهدى' — the real candidates surface, in order.

-- Pinned to `public` so the qualified calls below resolve under `set search_path = ''`.
create extension if not exists pg_trgm with schema public;

-- Trigram index on the NORMALIZED name, so orthographic variants and typos are both handled by
-- one path: normalization folds ة/ه, the alef family and ya/alef-maqsura; trigrams absorb what is
-- left (a dropped letter, a doubled one, a transposition).
create index if not exists source_of_sales_customer_map_name_trgm_idx
  on public.source_of_sales_customer_map
  using gin (public.phx_normalize_arabic(customer_name) public.gin_trgm_ops)
  where active;

drop function if exists public.phx_suggest_direct_order_pharmacies(text, numeric, int);

create function public.phx_suggest_direct_order_pharmacies(
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
         round(public.similarity(public.phx_normalize_arabic(m.customer_name), p.norm)::numeric, 3) as score
  from public.source_of_sales_customer_map m, probe p
  where m.active
    and p.norm is not null
    and m.customer_name is not null
    -- A nameless customer cannot be suggested BY NAME: offering a bare code as "did you mean"
    -- gives the rep nothing to recognise, and a suggestion they cannot judge is noise.
    and btrim(m.customer_name) <> ''
    and public.similarity(public.phx_normalize_arabic(m.customer_name), p.norm) >= coalesce(p_min_score, 0.35)
  order by m.distributor_code, m.customer_code, score desc
  limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

comment on function public.phx_suggest_direct_order_pharmacies(text, numeric, int) is
  'Did-you-mean suggestions for a claimed pharmacy name (spec B4). Arabic-normalized trigram '
  'similarity — deterministic on purpose, because a suggestion the rep was shown and refused is '
  'recorded as evidence and must reproduce identically later.';

revoke all on function public.phx_suggest_direct_order_pharmacies(text, numeric, int) from public;
grant execute on function public.phx_suggest_direct_order_pharmacies(text, numeric, int) to service_role;

-- Record of what the rep was shown before claiming the pharmacy is new (spec B4).
alter table public.direct_order_pharmacy_validations
  add column if not exists suggestions_shown jsonb,
  add column if not exists suggestions_refused boolean not null default false;

comment on column public.direct_order_pharmacy_validations.suggestions_shown is
  'The candidates Phoenix offered before this claim was submitted, with their scores. Kept so the '
  'question "was this rep shown the real pharmacy and went ahead anyway?" has an answer.';
