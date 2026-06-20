-- Unify the office line label to "Head Office" everywhere (owner: global-wide), same safe pattern
-- as the Anti infective rename (20260621240000).
--
-- lines.name id=4 was "Office" while Source of Sales official_line uses "Head Office" (66,907 import
-- rows). Rename the lines DISPLAY name only; lines.code stays "office" so import line_id matching,
-- the sales-access bridge map, and unrelated "Office" concepts are untouched.
--
-- Audited safe against prod ozucdzovmcqvepbozvqf:
--   * No DB function/view references the LINE literal 'Office' or 'Head Office'. The only hits,
--     phx_office_brick_share / phx_office_region_share, match `distributor_code = 'Office'` — the
--     sales CHANNEL/distributor, NOT the line. Those (and the weekly-plan activity type "Office")
--     are different concepts and must NOT change.
--   * employees.line_name has zero rows equal to 'Office'.
--   * Sales-access bridge (bridgeEmployeeLineToOfficial) already maps BOTH "office" and "head office"
--     -> "Head Office", so line visibility is unchanged.
--   * Code line-detection updated in the same PR to accept both "office" and "head office":
--     organogram isOfficeLine/isOfficeSelected (component + view-model) and admin normalizeLine
--     (which gains a "head office" -> "Office" governance alias so office staff don't fall to "Other").
-- Idempotent (guarded WHERE); reversible by setting the name back to 'Office'. lines.code stays "office".

update public.lines
set name = 'Head Office'
where id = 4 and btrim(name) = 'Office';
