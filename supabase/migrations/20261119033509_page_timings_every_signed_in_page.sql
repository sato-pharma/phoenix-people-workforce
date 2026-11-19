-- page_timings_every_signed_in_page
--
-- WHAT THIS CHANGES: page_timings_path_check, the shape a timed page's address must have. It took only
--   /employee-portals and /admin, three parts deep. It now takes any signed-in section (one lowercase
--   name, digits allowed, as in customer-360) and up to five parts after it, each a page name or :id.
-- WHY: enterprise audit F-PLT-015. The 106 office pages (sales, the workspace, recruitment, attendance,
--   coaching, leave, Customer 360, probation and the rest) were never timed, and the deepest admin pages
--   (a rep's day: /admin/field-crm/day/:id/:id) were refused. The application now decides WHICH sections
--   are timed (PAGE_TIMING_SECTIONS in src/lib/observability/page-timing-intake.ts, kept in step with
--   app/ by tests/page-timings.test.ts); the table keeps checking the SHAPE, so nothing but a page shape
--   with no query, no name and no id can ever be stored.
--   The new check is wider than the old one, so every row already stored passes it.
-- ROLLBACK: drop the constraint and add the old one back:
--   alter table public.page_timings drop constraint page_timings_path_check;
--   alter table public.page_timings add constraint page_timings_path_check check (char_length(path) <= 200
--     and path ~ '^/(employee-portals|admin)(/([a-z][a-z-]{0,48}|:id)){0,3}$');
--   It would fail while rows for office pages exist; delete those first (they are timings only).
--
-- Production has NO point-in-time recovery — 7 daily backups are the whole recovery story.
-- Nothing here is destructive or bulk: no row is changed or removed. Replaying it is harmless (it drops
-- and re-adds the same check), so the version the apply stamped in the ledger is the only row it needs.
-- Applied 19 Nov 2026 about 03:37 Cairo: staging (7 rows) and production (18,498 rows, none refused).

begin;

alter table public.page_timings drop constraint if exists page_timings_path_check;

alter table public.page_timings add constraint page_timings_path_check check (
  char_length(path) <= 200
  and path ~ '^/[a-z][a-z0-9-]{0,48}(/([a-z][a-z0-9-]{0,48}|:id)){0,5}$'
);

commit;
