-- Backfill marketing_products.line_id from the org `lines` table.
--
-- Problem: all marketing_products rows have line_id = NULL, so line-scoped marketing
-- roles (e.g. an "Anti Inf" rep) see an empty or partial product list and cannot submit
-- line-scoped marketing requests. The products carry a free-text `line` column, but the
-- text does not always match the org line name exactly:
--   product.line        lines.name      lines.id
--   ------------        ----------      --------
--   "CNS"               "CNS"           3   (exact, case-insensitive)
--   "Pedia"             "Pedia"         2   (exact, case-insensitive)
--   "Anti infective"    "Anti Inf"      1   (alias — text differs)
--
-- This migration is idempotent: it only touches rows where line_id IS NULL, and re-running
-- it is a no-op once every product is mapped.

-- 1) Exact (case-insensitive, trimmed) name match. Covers CNS + Pedia.
UPDATE marketing_products mp
SET line_id = l.id,
    updated_at = now()
FROM lines l
WHERE mp.line_id IS NULL
  AND mp.line IS NOT NULL
  AND lower(trim(mp.line)) = lower(trim(l.name));

-- 2) Known alias: the product line text "Anti infective" maps to the org line "Anti Inf".
UPDATE marketing_products mp
SET line_id = l.id,
    updated_at = now()
FROM lines l
WHERE mp.line_id IS NULL
  AND lower(trim(mp.line)) = 'anti infective'
  AND lower(trim(l.name)) = 'anti inf';

-- Verification (informational): after the two updates every active product should have a
-- line_id. If any remain NULL, a new/unknown line text was introduced and needs an alias.
DO $$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining FROM marketing_products WHERE line_id IS NULL;
  IF remaining > 0 THEN
    RAISE WARNING 'marketing_products still has % row(s) with NULL line_id after backfill; add an alias for the unmatched line text.', remaining;
  END IF;
END $$;
