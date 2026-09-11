-- Switch the email composer's "HR Team" and "Finance Team" groups onto distribution lists WITHOUT
-- changing who is in them.
--
-- Those groups are resolved today by matching a SUBSTRING of the department and job-title text
-- (roleText(employee).includes("hr")), which is invisible, unauditable, and catches or misses
-- people according to how a title happens to be typed. The lists replace that with app roles.
--
-- The two are NOT equivalent, and measured against production the difference is exactly two people
-- — each of whom the substring rule includes and the role rule would drop:
--
--   B-10    Omar Anwar     job title "HR Section Head", app role Super Admin  (not an HR seat)
--   OF-0002 Adel El Sayed  job title "Financial Advisor", app role Employee   (title/role disagree)
--
-- They are added as NAMED members so the first send after this lands reaches exactly the people the
-- last send before it reached. This is a preservation decision, not a permanent rule: both can be
-- removed from /admin/distribution-lists, which is the point of making the membership editable.
--
-- GUARDED ON `enabled = false`, the seeded state. If either list has already been switched on or
-- edited by hand, this leaves it alone rather than reverting somebody's decision — the same reason
-- the original seed used ON CONFLICT DO NOTHING.
begin;

update public.distribution_lists
set included_hr_ids = array['B-10']::text[],
    enabled = true,
    updated_at = now(),
    updated_by = 'migration:composer_groups'
where list_key = 'hr_team'
  and enabled = false;

update public.distribution_lists
set included_hr_ids = array['OF-0002']::text[],
    enabled = true,
    updated_at = now(),
    updated_by = 'migration:composer_groups'
where list_key = 'finance_team'
  and enabled = false;

commit;
