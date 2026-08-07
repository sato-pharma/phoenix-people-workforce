-- Direct orders: fold whitespace in phx_normalize_arabic (owner investigation, 2026-08-07).
--
-- Nermeen Salah's direct order held on a hand-typed pharmacy even though she supplied a real,
-- active distributor customer code (PS/0001556836, "السيد ابوالفتوح ج كفر شكر", 42 invoice lines
-- Jan-Jul 2026, 29,420 EGP). The customer WAS searchable through the 2026-08-04 directory search
-- (migration 20260804183000) -- but only if the typed name lines up character-for-character after
-- Arabic orthographic folding. That migration folds letter forms (hamza, ta-marbuta, alef-maqsura)
-- and strips harakat, but never touched spacing.
--
-- The stored name has "ابوالفتوح" as one word. A rep typing it naturally as two ("ابو الفتوح", the
-- more common spacing) produces a normalized query that is never a substring of the normalized
-- name, because the space survives normalization. Proven live against production before writing
-- this migration:
--   phx_normalize_arabic('السيد ابوالفتوح ج كفر شكر') ilike '%' || phx_normalize_arabic('السيد ابو الفتوح') || '%'
--   -> false today
-- Stripping whitespace from the normalized form on both sides makes it true, with no other change:
-- 'السيدابوالفتوح' is a substring of 'السيدابوالفتوحجكفرشكر'.
--
-- Consequence before this fix: a rep whose spacing does not match the stored record cannot find a
-- real, already-selling customer through the combo box, falls back to "enter it manually", and the
-- order lands on a hand-registered pharmacy that always starts `pending_review` (owner rule,
-- 2026-08-04) -- held for a System Admin to acknowledge, even though the code was correct all along.
--
-- CREATE OR REPLACE, not a fresh function: the signature and return type are unchanged, only the
-- normalization is stricter. Every Arabic character is a codepoint escape, matching the house rule
-- in the parent migration -- editing literal Arabic glyphs in a mixed LTR/RTL file is not safe.
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
          '[ً-ْٰـ]+', '', 'g'
        ),
        -- Whitespace is dropped entirely, not just collapsed. A stored name written as one word
        -- ("ابوالفتوح") and a typed query written as two ("ابو الفتوح") must normalize to the SAME
        -- string, because Egyptian pharmacy names have no fixed convention for where the space
        -- goes. Collapsing runs to a single space would not fix this case -- it is not a doubled
        -- space, it is a space that only one side has.
        '\s+', '', 'g'
      )
    ),
    ''
  );
$$;

comment on function public.phx_normalize_arabic(text) is
  'Fold Arabic orthographic variants (alef family, ta-marbuta/ha, alef-maqsura/ya), strip '
  'harakat/tatweel, and drop all whitespace, so a typed name matches a stored one regardless of '
  'word spacing. IMMUTABLE -- safe to index on.';

-- The expression index on source_of_sales_customer_map still holds values computed under the OLD
-- function body. A plain CREATE OR REPLACE FUNCTION does not recompute an index that depends on it.
-- Correctness of the search itself does not depend on this index today -- phx_search_direct_order_customers
-- matches with a leading-wildcard ILIKE ('%' || norm || '%'), which a text_pattern_ops b-tree cannot
-- serve, so Postgres evaluates phx_normalize_arabic(customer_name) fresh per row regardless of the
-- index's stored value. Reindexing anyway so the index does not silently carry stale values for any
-- future prefix-style query that could use it.
reindex index public.source_of_sales_customer_map_norm_name_idx;
