---
name: sos-scratch-tables-were-anon-readable
description: "33 underscore-prefixed SoS scratch tables sat in public with RLS off and SELECT granted to anon — real data was readable over the internet with the publishable key until 2026-07-30"
metadata: 
  node_type: memory
  type: project
  originSessionId: bbaeb912-9113-487f-bde3-b93f1e402c0a
  modified: 2026-07-30T00:56:35.206Z
---

**2026-07-30.** The 2026-07-28/29 Source-of-Sales brick merge / rescue / area-fix work left 33
`_`-prefixed tables in `public`. Every one had RLS off **and** SELECT granted to `anon`. `public` is
the schema PostgREST exposes, so all 33 were readable over HTTPS with the publishable anon key that
ships to every browser. Proven, not inferred:
`GET /rest/v1/_import_snapshot_dupmerge_20260728` → HTTP 206, `Content-Range: 0-0/3909`. Content
included customer→brick mappings and raw invoice lines (client names, addresses, values).

The same sweep found `public.source_of_sales_block_groups` created by
`20260728190000_sos_block_grouping.sql` with a bare `create or replace view` — i.e. SECURITY DEFINER
semantics. Its four base tables were correctly locked (RLS on, no anon SELECT), so **the view was the
only leak path** for that data; anon read 154 rows through it.

**Resolved:** migrations `20260730120100` (20 undo tables → private `sos_merge_undo_20260728` schema,
13 derived working sets dropped) and `20260730120200` (`security_invoker = true`, 2 search_path pins,
7 FK indexes). Production security advisors went **34 ERROR → 0** (121 → 85 total). Re-probed after:
404 on the scratch tables, 42501 on the view.

**Why:** ad-hoc `create table _foo as select …` during a live data operation inherits the public
schema's default ACL, which grants `anon`/`authenticated` — see
[[public-schema-default-acl-grants-authenticated]]. The linter calls this INFO/ERROR but nothing
blocks it at creation time, so any future hands-on data surgery in `public` reopens the same hole.
Do that work in a private schema from the start.

**How to apply:** classify such tables by **column shape, not name** — the `*_plan` tables looked like
scratch but are `dead_id → keep_id` maps, i.e. the only way to reverse a merge. Still open:
staging-only `_sos_master_load` and `_sos_xwalk_load` are anon-readable and staging is a 1:1 data
clone of production. Related: [[supabase-advisor-by-design]], [[sos-owner-standing-rules-from-session-369dd08d]].
