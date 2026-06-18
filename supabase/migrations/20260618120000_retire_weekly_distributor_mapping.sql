-- ─────────────────────────────────────────────────────────────────────────────
-- Retire weekly_distributor_mapping + weekly_missing_mappings.
--
-- Context: weekly_distributor_mapping (20260614230000) was built to supersede
-- weekly_sales_pos_region_mappings, but the upload parser never adopted it — it
-- already uses weekly_sales_branch_region_map (branch→region) and
-- weekly_sales_product_aliases (product code/name→master) for all resolution.
-- weekly_distributor_mapping was therefore UI-only (Mapping Workbook tab).
-- weekly_missing_mappings tracked open labels from that tab (Missing Labels tab).
-- Both tabs are retired in the companion code release; this migration carries the
-- live user-entered data over so nothing is silently lost.
--
-- ⚠ Apply AFTER the code release (PR that removes the tabs and API routes) has
-- been deployed, so the app never hits these tables after the DROP.
--
-- Steps
--   1. Migrate product rows  → weekly_sales_product_aliases  (ON CONFLICT DO NOTHING)
--   2. Migrate region rows   → weekly_sales_branch_region_map (ON CONFLICT DO NOTHING)
--   3. DROP weekly_distributor_mapping
--   4. DROP weekly_missing_mappings
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Product rows → weekly_sales_product_aliases
-- All stored PS product rows are Arabic product NAMES (not item codes) → alias_kind='name'.
-- normalized_alias mirrors normalizeKey() semantics used by the upload parser:
--   NFKC + alef-hamza fold (أإآٱ→ا) + alef-maqsura fold (ى→ي)
--   + diacritic/tatweel strip + lowercase + whitespace collapse.
INSERT INTO public.weekly_sales_product_aliases
  (distributor_code, alias, alias_kind, normalized_alias, product_code, created_by, updated_by, created_at, updated_at)
SELECT
  wdm.distributor_code,
  wdm.raw_value                                                                      AS alias,
  'name'                                                                             AS alias_kind,
  lower(trim(regexp_replace(
    regexp_replace(
      translate(
        normalize(wdm.raw_value, 'NFC'),
        E'أإآٱى',   -- أإآٱى (alef-hamza forms + alef-maqsura)
        E'ااااي'    -- ا ا ا ا ي  (bare alef + ya)
      ),
      E'[ً-ْٰـ]', '', 'g'   -- strip diacritics + tatweel
    ),
    '\s+', ' ', 'g'
  )))                                                                                AS normalized_alias,
  wdm.official_code                                                                  AS product_code,
  coalesce(wdm.updated_by, 'migration-20260618')                                    AS created_by,
  coalesce(wdm.updated_by, 'migration-20260618')                                    AS updated_by,
  wdm.created_at,
  wdm.updated_at
FROM public.weekly_distributor_mapping wdm
WHERE wdm.dimension = 'product'
  AND NOT EXISTS (
    SELECT 1
    FROM public.weekly_sales_product_aliases wpa
    WHERE wpa.distributor_code = wdm.distributor_code
      AND wpa.alias_kind = 'name'
      AND wpa.normalized_alias = lower(trim(regexp_replace(
            regexp_replace(
              translate(
                normalize(wdm.raw_value, 'NFC'),
                E'أإآٱى',
                E'ااااي'
              ),
              E'[ً-ْٰـ]', '', 'g'
            ),
            '\s+', ' ', 'g'
          )))
  );

-- 2. Region rows → weekly_sales_branch_region_map
-- source_file_type='any' (all map_type values are 'combined').
-- normalized_branch: use stored normalized_raw_value (lowercase branch name).
--   For the English branch names that make up all PS region rows, both
--   normalizeWeeklyPosColumnName() and normalizeKey() produce identical output.
-- region_name: resolved from source_of_sales_regions (same source the parser uses).
INSERT INTO public.weekly_sales_branch_region_map
  (distributor_code, raw_branch, normalized_branch, source_file_type,
   region_code, region_name, excluded, created_by, updated_by, created_at, updated_at)
SELECT
  wdm.distributor_code,
  wdm.raw_value                                                                       AS raw_branch,
  wdm.normalized_raw_value                                                            AS normalized_branch,
  'any'                                                                               AS source_file_type,
  upper(trim(wdm.official_code))                                                      AS region_code,
  coalesce(sor.region_name, upper(trim(wdm.official_code)))                           AS region_name,
  false                                                                               AS excluded,
  coalesce(wdm.updated_by, 'migration-20260618')                                     AS created_by,
  coalesce(wdm.updated_by, 'migration-20260618')                                     AS updated_by,
  wdm.created_at,
  wdm.updated_at
FROM public.weekly_distributor_mapping wdm
LEFT JOIN public.source_of_sales_regions sor
  ON upper(trim(sor.region_code)) = upper(trim(wdm.official_code))
WHERE wdm.dimension = 'region'
  AND NOT EXISTS (
    SELECT 1
    FROM public.weekly_sales_branch_region_map wbr
    WHERE wbr.distributor_code = wdm.distributor_code
      AND wbr.normalized_branch = wdm.normalized_raw_value
  );

-- 3. Drop retired mapping table
DROP TABLE IF EXISTS public.weekly_distributor_mapping;

-- 4. Drop retired missing-labels capture table
DROP TABLE IF EXISTS public.weekly_missing_mappings;
