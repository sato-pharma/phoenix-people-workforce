-- Unify the Anti Infective line label to "Anti infective" everywhere (owner: system-wide).
--
-- The lines table (org source of truth) carried name "Anti Inf" for line id=1, while every
-- other surface uses "Anti infective": marketing_products.line, source_of_sales_products.line,
-- and 4,868 source_of_sales_import_rows. This split surfaced on the Sales & Marketing
-- Intelligence ROI dashboard once the request Line started resolving from the requester's
-- org line: the request table showed "Anti Inf" (org line) while the Line breakdown chart and
-- the filter dropdowns showed "Anti infective" (product taxonomy).
--
-- Fix: rename the DISPLAY name only. The internal code stays "anti_inf", so nothing that keys
-- off the code / line_id / the "anti inf" alias changes. Display everywhere resolves via
-- line_id -> lines.name, so this single rename propagates to the employee directory, the ROI
-- dashboard request Line, and the marketing request UI automatically.
--
-- Audited safe against prod ozucdzovmcqvepbozvqf:
--   * No DB function or view references the literal 'Anti Inf'.
--   * Sales access scope (src/lib/sales/access-scope.ts) bridges BOTH "anti inf" and
--     "anti infective" -> "Anti infective", so line visibility is unchanged.
--   * Marketing line-scope (marketingProductMatchesRequesterLine) matches by line_id first,
--     with an alias-tolerant name fallback ("anti infective" -> "anti inf"), so it still matches.
--   * Employee import resolves the line by the explicit code "anti_inf" (lines.code), not name.
-- Idempotent (guarded WHERE clauses); reversible by setting the name back to 'Anti Inf'.
-- NOTE: lines.code stays "anti_inf" and lines.name id=4 stays "Office" (vs SoS "Head Office")
-- on purpose -- the owner asked only to unify the Anti Infective line; codes are internal.

update public.lines
set name = 'Anti infective'
where id = 1 and btrim(name) = 'Anti Inf';

-- One legacy free-text employees.line_name row still held the abbreviation; the canonical
-- line is line_id -> lines.name, but normalise the stray text for full consistency.
update public.employees
set line_name = 'Anti infective'
where upper(btrim(line_name)) = 'ANTI INF';
