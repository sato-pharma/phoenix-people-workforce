---
name: weekly-mapping-template-is-update-plus-a-ceo-exception
description: "The weekly mapping-template route is gated on weekly_sales:update PLUS an explicit CEO branch — deliberate, not an inconsistency to clean up."
metadata: 
  node_type: memory
  type: project
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-20T22:58:06.393Z
---

`/api/sales/weekly/normalizer/mappings/template` is gated by
`assertWeeklyMappingTemplatePermission` — `weekly_sales:update` **OR** `role === "CEO"`.
Both halves are deliberate. Do not "simplify" it back to a plain `assertPermission`.

The workbook embeds the **unscoped** master catalogue (every product code/name/line, every region,
every area) including the confidential Head Office line LA003/LA004/SS001.

- It was on `weekly_sales:export` until 2026-08-21 (#2234). `export` reaches down to **Medical Rep**,
  so the whole sales field could pull that catalogue. That was the bug.
- `update` is held by **Super Admin + SFE Manager only** — which swept up the CEO, who holds
  `read,export`. Fixed same day by #2236 with an explicit CEO branch, because the CEO is one of
  exactly two roles `canViewHeadOffice` already clears for the Head Office line
  (see [[owner-office-allocation-rule-value-share]] for the neighbouring Office rules).
- **Not** fixed by granting CEO `weekly_sales:update` — that would also give him
  create/delete/approve/import on every other weekly_sales route.

Same shape as the pre-existing `canAccessFingerprintReport` CEO exception; registered with
`guard: "domain-helper"` in `access-registry.ts`, which is how this repo marks "gated by a domain
helper, not by the plain matrix". Every sibling normalizer route (preview / save / learn /
ai-suggest) stays `update`-only.

**Why:** the audience is now pinned by a 16-role test in `tests/weekly-sales-access.test.ts` — 3 in
(Super Admin, SFE Manager, CEO), 13 out. A session that "cleans up" the CEO branch will go red there,
which is the intended alarm, not a broken test.

**How to apply:** before changing this route's gate, check who holds the action in
`permissionMatrix` AND check `role_permission_overrides` in prod — `canAccess` consults that table at
runtime, so the compiled matrix is not automatically the live audience. As of 2026-08-21 prod has
1 override row total and **zero** for `weekly_sales`. See
[[a-role-probe-cannot-trust-the-http-status-code]] — curl against **production** cannot verify this gate,
CSRF rejects every forged role header at `403 csrf_blocked` before `assertPermission` ever runs.

**The sweep that does work** is a LOCAL dev-auth one (`PHOENIX_ENABLE_DEV_AUTH_HEADERS=true
pnpm exec next dev --turbopack --port 3000`, then `x-phoenix-role` + `x-phoenix-hr-id` +
`Origin: http://localhost:3000`). Read the **body**, never the status. Post an empty body so the
route bails at its own `!distributorCode` 400 — that bail sits after the permission check and before
every write, so nothing reaches the production DB `.env.local` points at. Verified 2026-08-21 across
16 roles × 5 routes: `Pick a distributor.` = passed the gate, `Forbidden: <Role> cannot …` = denied.
The CEO exception is **template-only** — he is 403 on preview/save/learn/ai-suggest, 400 on template.
