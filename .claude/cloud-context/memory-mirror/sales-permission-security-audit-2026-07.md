---
name: sales-permission-security-audit-2026-07
description: "A 2026-07 sales/export permission audit, now fully closed — its durable residue is the RECURRING bug taxonomy to expect if handed another finding: a read-vs-import/export permission-matrix mismatch (a route gating on :read, which every role holds, instead of :import/:export), a missing scope filter on a service-role RLS-bypassing query, a DB grant/RPC that doesn't implement the filtering its own comment claims, an unguarded guest caller, or a CSRF same-origin gap. Plus the enforcement mechanisms that catch them and the process lessons."
metadata:
  node_type: memory
  type: project
  originSessionId: 86ddb63c-e23b-45a8-b3ba-f8deb68c9b34
  modified: 2026-09-26T00:25:26.471Z
---

A lead session delivered a permission-gate / data-scoping findings table one row at a time. Every row
picked up was fixed, merged and prod-verified in 2026-07 — the tracker itself is spent. What survives is
the **pattern** to expect if a future session is handed another row from the same kind of audit.

## The recurring bug taxonomy

1. **`read`-vs-`import`/`export` permission-matrix mismatch.** A route gates on a `:read` action that
   *every* role holds when it should gate on `:import`/`:export` (Super Admin + SFE Manager only). Seen on
   `weekly/export-batches` (leaked a company-wide unfiltered workbook incl. confidential LA003/LA004/SS001
   to every sales role — [[weekly-sales-module-map]]) and `monthly-import/dashboard`. Note SFE Manager
   *legitimately* needs the unscoped company-wide view for import validation, so the fix is `:import`, NOT
   a "Super-Admin-only" gate that would wrongly block SFE Manager.
2. **A missing scope filter on a service-role (RLS-bypassing) query.** `loadSourceOfSalesDashboard()` and
   similar use the service-role client with zero region/area/brick/distributor/line scoping — only
   confidential-product stripping — so the *route's* permission check is the only boundary; a wrong check
   there hands any caller the full company breakdown.
3. **A DB grant / RPC that doesn't implement the filtering its own comment claims.** `analytics_readonly`
   (the `metabase` login inherits it) had EXECUTE on `phx_*` RPCs whose comment said they filter
   confidential codes internally — they didn't ([[la003-la004-confidential-products]] holds the full BI
   surface lesson).
4. **An unguarded guest caller.** `GET /api/calendar` with no session cookie returned full company
   calendar data — the service function never threw on `access.source === "guest"`.
5. **A CSRF same-origin gap.** `assertSameOriginMutation(request)` applied to only a handful of mutating
   routes. Defense-in-depth debt (SameSite cookies mitigate), not an active bypass.

## Enforcement mechanisms that catch these (durable)

- **CSRF coverage is self-enforcing:** `src/lib/security/access-registry.ts` declares per-route
  `csrfRequired`, and `tests/access-registry-coverage.test.ts` **fails the build if a route marked
  required doesn't call the guard.** So a new mutating route is caught by flipping its registry entry —
  add the guard AND the entry together. (An older narrower `tests/csrf-route-coverage.test.ts` hardcoded
  list is superseded by the registry check.)
- **Per-employee authorization must mirror the attendance route's boundary.** When a route takes an
  arbitrary `hrId` (e.g. activity timeline), copy `assertCanViewEmployeeAttendance`'s exact boundary:
  self / whole-company for Super-Admin·CEO·company-or-system-scope / **DB-verified direct-report-only**.
  A resource-level `user_activity:read` check alone (Super-Admin-only *today*) is fragile against a future
  `role_permission_overrides` widening. Test it with the `B-1`-vs-`B-10` substring trap (a prefix match is
  not a manager match), plus guest/no-scope/missing-identity denials.

## Process lessons

- **Don't trust a `git worktree list` snapshot as proof of what's shipped.** Worktrees get created and
  removed by other sessions, so a branch appearing (or not appearing) locally is not evidence. Before
  starting a finding, search GitHub for an existing PR/branch matching it (`gh api .../issues`,
  `search_issues`) to avoid duplicate work.
- **Work each finding in an isolated worktree off fresh `origin/main`** → fix → verify the affected roles
  (including the denial paths) → PR → merge → verify prod ([[parallel-session-swarm-hazard]]).
- **Scope narrowly to exactly the routes the finding names** — do not expand to other similar-looking gaps
  unasked (the CSRF fix deliberately left `PATCH /api/notifications/settings` and the telegram routes
  alone).
- A unit test + preview-smoke covers a fix, but does **not** re-prove the live role split (Super Admin 200
  vs others 403) unless you run a credentialed prod-role test — state that caveat rather than implying it.
