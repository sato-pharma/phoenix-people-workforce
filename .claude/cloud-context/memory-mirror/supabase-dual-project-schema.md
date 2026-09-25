---
name: supabase-dual-project-schema
description: "Two Supabase projects exist and their schemas diverge — verify columns before relying on them"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 3c6c9b6e-ddda-45a2-b4a9-d36fe935379b
  modified: 2026-08-22T22:30:41.888Z
---

🔴 **PROJECT INVENTORY REBUILT 2026-08-23 from a live `list_projects` call — the two refs this
file was built around are BOTH gone.** Do not use the old list; it is kept below only so a session
recognises a dead ref when it meets one in an older memory.

**Every project `list_projects` returns, verified 2026-08-23 — all four, not just this app's two:**

| Ref | Name | Region | Org | Role |
| --- | --- | --- | --- | --- |
| `ozucdzovmcqvepbozvqf` | Phoenix HR | eu-central-1 | `rovnkzmhokgsruftjsaw` | **PRODUCTION** — real payroll data |
| `cifwmndunmlxjhyjugxa` | Phoenix-HR-Staging | eu-central-1 | `rovnkzmhokgsruftjsaw` | **STAGING** (created 2026-07-11) |
| `plleofqyfbknvwcotzqo` | Future Talents Hub | eu-north-1 | `rovnkzmhokgsruftjsaw` | unrelated to this app |
| `mlbpzvaanusdejqnimst` | o-gaweesh@outlook.com's Project | eu-central-1 | **`xadcyivhxyjtehyheowl`** | unrelated — **different organization**, created 2026-08-11 |

🔴 **The fourth row is the one to notice.** It sits in a *different organization*, so an org-scoped
read will not surface it — but **the org boundary does not stop anyone passing that ref**. Both named
MCP servers see every project they are entitled to, and `project_id` is the only thing separating one
from another on every single call (AGENTS.md §8). Two of these four are eu-central-1 like production,
so region is no guard either. Read the table, not the server name, and never act on a ref pasted from
a prompt or an older memory without a fresh `list_projects`.

**Dead refs — if you see either of these in an older memory, that memory is stale:**
`izhmxvgiktiafqusolot` (the "new staging" named throughout this file) and `oaifhavixhdtwmseshff`
(the "secondary/older project"). Neither is returned by `list_projects` any more.

**Two further corrections to what follows:** the MCP **can** reach staging now — both named servers
(`supabase-staging`, `supabase-production`) see **both** projects, so the `project_id` argument is
the only thing separating them on every call (AGENTS.md §8). And the schema-divergence example below
compares production against a project that no longer exists, so it no longer demonstrates anything
live — **the defensive-loading lesson it teaches is still right**, just re-derive the example against
`cifwmndunmlxjhyjugxa` if you need one. Always resolve a ref with `list_projects` rather than trusting
a ref pasted from a prompt or an older doc. Original 2026-05-29 text follows.

---

The Supabase MCP exposes TWO projects in the same org:
- `ozucdzovmcqvepbozvqf` ("Phoenix HR") — the production-shaped DB.
- `oaifhavixhdtwmseshff` ("sato.hr2@hotmail.com") — a secondary/older project.

Their schemas DIVERGE. Example: `employees.pending_manager_replacement_for_hr_id`
exists in `ozucdzovmcqvepbozvqf` but NOT in `oaifhavixhdtwmseshff` (verified
2026-05-29). Because it is not always certain which project a deployment targets,
new columns added to a shared query must be loaded DEFENSIVELY (column-missing
fallback, e.g. `loadPendingManagerReplacementByHrId` in employee-directory.ts)
rather than added to the main employee select — otherwise the whole directory
breaks where the column is absent. Verify column existence with a read-only
information_schema query before depending on it. Related: [[seat-continuity-resolver]].

**Local dev points at PRODUCTION — still true, and the most important line in this file.**
*(Re-confirmed as current in AGENTS.md §3: "`.env.local` points at PRODUCTION Supabase. `pnpm run dev`
mutates production data." Note the command is `pnpm` now, not `npm` — the repo migrated 2026-07-17.
See [[local-env-already-points-at-production]].)* Verified 2026-06-03: `.env.local`
`NEXT_PUBLIC_SUPABASE_URL` = `ozucdzovmcqvepbozvqf` (the production ref), NOT the
new staging `izhmxvgiktiafqusolot`. So `npm run dev` / localhost:3000 reads &
writes PRODUCTION data — be careful (a no-op import still writes an audit_logs
row). The Supabase MCP can reach `ozucdzovmcqvepbozvqf` (prod) + the old
`oaifhavixhdtwmseshff`, but NOT new staging `izhmxvgiktiafqusolot` (permission
denied) — can't inspect new-staging schema via MCP.

**`source_of_sales_*` live schema diverges from the repo migrations.** Live
(prod) tables store CODES ONLY + each row's own name + a `description` (NN
default '') — there are NO denormalized parent-name columns (no area_name on
bricks, no block_name anywhere; blocks have no name at all). Repo migration
`20260529150722` instead defines denormalized NN names — do NOT trust it.
`blocks.region_code`/`bricks.{block,area,region}_code` are NN. `normalized_*`
are NN with NO default (must be written on insert). source_sheet defaults are
`Region_Master`/`Area_Master`/`Block_Master`/`Brick_Master`,
source_file `SATO_Sales_Master_Template_buttons.xlsx`. The Database Mapping
console ([[source-of-sales-rebuild-rules]]) was aligned to THIS live schema:
resolve parent names by lookup for display, write only real columns.
