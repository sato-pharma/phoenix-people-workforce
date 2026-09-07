-- The database kept its own copy of "who is a warehouse", and it stopped at the six words.
--
-- `src/lib/sales/customer-channel.ts` declares itself THE single edit point for this rule, and by
-- 2026-09-07 it resolved a customer in eight steps: owner rulings by code, by distributor+code, by
-- company name and by chain; the "never a store" words; a wholesale-only distributor; then the six
-- keywords, the EPDA «م - » PREFIX, and the trade phrase. SQL implemented exactly two of them —
-- hospital stems and store stems, both as substrings — because every SQL copy was written when the
-- rule WAS those two lists.
--
-- The gap is not theoretical. Measured on production for 2026-08 alone, 9 customers carry the
-- «م - » prefix and none of the six words — 972,232.88 EGP, of which 13,030.88 sits on a rep line.
-- The owner ruled every one of them a warehouse on 2026-09-07 ("all those warhouse and should be
-- splitted"), the app agrees, and the Channels by Rep tab still called them pharmacies. Same
-- customers, two answers, on screens that sit beside each other.
--
-- WHAT THIS DOES. One SQL function now holds the rule — `phx_customer_channel` — and it reads every
-- list from a single jsonb payload built in TypeScript from those same exported constants
-- (`src/lib/sales/customer-channel-sql-rule.ts`). A list added to customer-channel.ts reaches SQL
-- by appearing in that payload; nothing here has to be edited again, which is the whole point.
--
-- WHY THE OLD ARRAY PARAMETERS SURVIVE. A migration lands on production before the code that calls
-- it. Between the two, the running app still calls with `p_store_stems` and no payload — so an
-- empty payload falls back to those arrays and reproduces TODAY's answer exactly, rather than
-- classifying every customer as a pharmacy for the length of a deploy.
--
-- SCOPE. `phx_sales_channels_by_rep` only, in the migration beside this one. `phx_closing_channel_totals` and
-- `phx_closing_channel_breakdown` carry the same two-step copy and the same gap; they are a
-- separate change because their bodies also decide the unidentified/direct buckets, and this one is
-- meant to be reviewable. Neither of them decides who is CREDITED with a sale: the city split that
-- moves money between reps lives in TypeScript (`store-sales-city-split.ts`) and already has the
-- owner's rulings.

-- ── 1. Folding ───────────────────────────────────────────────────────────────────────────────────
-- The lam-alef PRESENTATION FORMS were missing here while normalizeCustomerName() in TypeScript has
-- folded them since 2026-09-06. They are single codepoints standing for two letters, so `translate`
-- — which is strictly 1:1 — cannot express them and they were quietly left out. Real customer names
-- the owner ruled are warehouses carry them ("الاهرام لتجارةاﻻدويةومستلزمات الطبية"), and without
-- this the trade phrase below cannot see the goods word in those names at all.
create or replace function public.phx_fold_customer_name(p_name text)
returns text
language sql
immutable
parallel safe
as $function$
  select btrim(regexp_replace(
           lower(translate(
             replace(replace(replace(replace(replace(replace(replace(replace(
               regexp_replace(coalesce(p_name, ''), '[ً-ْـٰ]', '', 'g'),
               'ﻵ', 'لا'), 'ﻶ', 'لا'), 'ﻷ', 'لا'), 'ﻸ', 'لا'),
               'ﻹ', 'لا'), 'ﻺ', 'لا'), 'ﻻ', 'لا'), 'ﻼ', 'لا'),
             'أإآٱةىیک', 'ااااهييك')),
           '\s+', ' ', 'g'));
$function$;

comment on function public.phx_fold_customer_name(text) is
  'Customer name folded for comparison: harakat stripped, interchangeable letters unified, lam-alef ligatures expanded, latin lowercased, whitespace collapsed. Mirrors normalizeCustomerName() in src/lib/sales/customer-channel.ts.';

-- ALL whitespace removed, not merely collapsed. Distributors split words mid-token — "الصفا ميديكال
-- لتجارة وتوزيع الا دوية" carries a space inside الأدوية — so the trade phrase is tested on this
-- form. Safe for those stems because each is a single Arabic word.
create or replace function public.phx_squash_customer_name(p_name text)
returns text
language sql
immutable
parallel safe
as $function$
  select replace(public.phx_fold_customer_name(p_name), ' ', '');
$function$;

comment on function public.phx_squash_customer_name(text) is
  'phx_fold_customer_name with every space removed. Mirrors squashCustomerName() in src/lib/sales/customer-channel.ts.';

revoke execute on function public.phx_squash_customer_name(text) from public, anon, authenticated;
grant execute on function public.phx_squash_customer_name(text) to service_role;

-- ── 2. The rule, once ────────────────────────────────────────────────────────────────────────────
-- Precedence is `classifyCustomerChannel()` then `isStoreCustomer()`, in their exact order. Each
-- step is an owner decision, and a step is only ever reversed by a MORE specific one above it —
-- which is what stops the broad name tests at the bottom from undoing a ruling about one account.
--
-- MATCHING FORM PER LIST, and they genuinely differ:
--   store / hospital stems      spaced,  substring
--   store prefixes              spaced,  START of the name only
--   owner name rulings, chains,
--   and the never-store words   spaced OR squashed, substring
--   trade phrase                squashed, substring
--
-- The prefix distinction is load-bearing rather than tidy. «م - » starts 29 names and appears
-- somewhere inside 623; matching it as a substring would reclassify 594 ordinary pharmacies as
-- warehouses and scatter their sales across their cities, and nothing downstream would report it,
-- because the split preserves each line's unit total while moving units between areas.
create or replace function public.phx_customer_channel(
  p_client_name text,
  p_client_code text,
  p_distributor_code text,
  p_period text,
  p_official_line text,
  p_rule jsonb
)
returns text
language plpgsql
immutable
parallel safe
as $function$
declare
  v_spaced   text := public.phx_fold_customer_name(p_client_name);
  v_squashed text := public.phx_squash_customer_name(p_client_name);
  v_code     text := ltrim(btrim(coalesce(p_client_code, '')), '0');
  v_dist     text := upper(btrim(coalesce(p_distributor_code, '')));
  v_line     text := regexp_replace(lower(btrim(coalesce(p_official_line, ''))), '[\s_-]+', ' ', 'g');
  v_from     text;
  v_active   boolean;
begin
  -- Hospital wins the name overlap: a name like "جمعيه ... (ص مستشفى)" carries both, and it is the
  -- hospital that identifies the customer.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'hospitalStems', '[]'::jsonb)) s
    where s <> '' and v_spaced like '%' || s || '%'
  ) then
    return 'hospital';
  end if;

  -- Owner PHARMACY rulings by code outrank every store test. Keyed by customer code alone: the same
  -- shop is a pharmacy whichever distributor sold to it.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'pharmacyOverrideCodes', '[]'::jsonb)) c
    where v_code = ltrim(btrim(c), '0')
  ) then
    return 'pharmacy';
  end if;

  -- Owner STORE rulings, keyed by distributor + code because a code is unique only inside one
  -- distributor's catalogue.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeOverrideKeys', '[]'::jsonb)) k
    where v_dist = upper(btrim(split_part(k, '|', 1)))
      and v_code = ltrim(btrim(split_part(k, '|', 2)), '0')
  ) then
    return 'store';
  end if;

  -- Is the 2026-09-06 rule in force for this row's period AND line? The lines were published on
  -- different days and a published month never moves, so the cutover is per line. No payload, or a
  -- period before the cutover, falls to the rule exactly as it stood before: the six words plus the
  -- two code-keyed lists, both already answered above.
  v_from := coalesce(
    p_rule -> 'ruleFromPeriodByLine' ->> v_line,
    p_rule ->> 'ruleFromPeriodDefault'
  );
  v_active := v_from is not null
          and coalesce(p_period, '') ~ '^\d{4}-\d{2}$'
          and p_period >= v_from;

  if v_active then
    -- A ruling about one COMPANY, by name — it trades under several codes across distributors.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeOverrideNameStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'store';
    end if;

    -- A ruling about one company or a whole CHAIN that it is a pharmacy. Over-matching here is safe
    -- and is why a name is usable: this list can only ever refuse a store, never create one.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'pharmacyOverrideNameStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'pharmacy';
    end if;

    -- "Never a store": a pharmacy, a hospital, a paperwork note typed into the name field, or a
    -- government depot, which supplies its own institutions rather than a city's pharmacies.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'neverStoreStems', '[]'::jsonb)) s
      where s <> '' and (v_spaced like '%' || s || '%' or v_squashed like '%' || replace(s, ' ', '') || '%')
    ) then
      return 'pharmacy';
    end if;

    -- A distributor whose entire customer base is wholesalers. The name test exists to guess at a
    -- customer nobody has classified; here there is nothing to guess.
    if v_dist <> '' and exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'wholesaleOnlyDistributors', '[]'::jsonb)) d
      where v_dist = upper(btrim(d))
    ) then
      return 'store';
    end if;

    -- The six words, the start-anchored prefixes, and the trade phrase.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeStems', '[]'::jsonb)) s
      where s <> '' and v_spaced like '%' || s || '%'
    ) then
      return 'store';
    end if;

    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storePrefixes', '[]'::jsonb)) s
      where s <> '' and v_spaced like s || '%'
    ) then
      return 'store';
    end if;

    -- The phrase: the name has to say its BUSINESS is trading or distributing, and then either name
    -- the goods or carry both halves of تجارة + توزيع. تجارة on its own is right 47% of the time.
    if exists (
      select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'tradeBusinessStems', '[]'::jsonb)) s
      where s <> '' and v_squashed like '%' || s || '%'
    ) and (
      (
        jsonb_array_length(coalesce(p_rule -> 'tradeBusinessPair', '[]'::jsonb)) > 0
        and not exists (
          select 1 from jsonb_array_elements_text(p_rule -> 'tradeBusinessPair') s
          where s = '' or v_squashed not like '%' || s || '%'
        )
      )
      or exists (
        select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'tradeGoodsStems', '[]'::jsonb)) s
        where s <> '' and v_squashed like '%' || s || '%'
      )
    ) then
      return 'store';
    end if;

    return 'pharmacy';
  end if;

  -- Pre-cutover, or no payload: the six words and nothing else.
  if exists (
    select 1 from jsonb_array_elements_text(coalesce(p_rule -> 'storeStems', '[]'::jsonb)) s
    where s <> '' and v_spaced like '%' || s || '%'
  ) then
    return 'store';
  end if;

  return 'pharmacy';
end;
$function$;

comment on function public.phx_customer_channel(text, text, text, text, text, jsonb) is
  'THE channel rule in SQL, in one place. Payload is built by customerChannelSqlRule() in src/lib/sales/customer-channel-sql-rule.ts from the exported lists in customer-channel.ts, which stays the single edit point. An empty payload answers with the six store stems alone, which is what every caller sent before 2026-09-07.';

revoke execute on function public.phx_customer_channel(text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.phx_customer_channel(text, text, text, text, text, jsonb) to service_role;
