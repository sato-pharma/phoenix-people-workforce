---
name: an-unauthenticated-caller-has-role-employee-not-null
description: "An unauthenticated request does NOT get a null role — it gets role \"Employee\" with source \"guest\", so every `if (!access.role) return 401` guard in this repo is dead code and the caller gets a 403 instead."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e92ac6c-8bb7-4d65-855c-6c7ae9cf22de
  modified: 2026-08-22T21:56:23.374Z
---

`resolveAccessContext` / `resolveAccessContextFromPage` fall through to `anonymousAccessContext`
(`src/lib/auth/server.ts:76`) when there is no session cookie:

```ts
const anonymousAccessContext = createAccessContext({ hrId: null, role: "Employee", source: "guest" });
```

So **`access.role` is never null.** A route written as `if (!access.role) return 401` never fires;
an anonymous caller falls straight through to whatever role check comes next and is answered **403**,
not 401. Verified live on prod 2026-08-23: `GET /api/business-review/export` with no cookie returns
`403 {"error":"Forbidden: Business Review export"}` even though the file's first guard is a 401.

The behaviour is **fail-closed and safe** — arguably better, since 403 does not confirm that logging
in would help. What is wrong is only the dead branch, which reads as though the case is handled.

**The idiom the rest of the repo uses is `access.source === "guest"`** — five routes do it that way
(`app/api/marketing-requests/bulk-upload`, `app/api/employees/[hrId]/photo`, `app/api/report-it/[id]`,
`app/(admin)/admin/outstation/expense-command`, and the calendar route fixed in PR #673 after a real
guest data leak — see [[sales-permission-security-audit-2026-07]]). As of 2026-08-23 exactly one
route still uses the `!access.role` form: `app/api/business-review/export/route.ts:26`.

**Why:** a guest context with a real-looking role is what makes the app render a sensible logged-out
shell instead of crashing, but it also means "no role" is not how you detect "not logged in".

**How to apply:** to answer 401 for an anonymous caller, test `access.source === "guest"`. Never
write `!access.role` and never assert in a test or a PR description that a 401 path is reachable —
probe the deployed route and read the status back. `tests/business-review-portal-scope.test.ts` pins
the ordering of that route's two guards at source level, which is true, but the 401 branch it pins is
currently unreachable; the comment there says so.

Related: [[a-role-probe-cannot-trust-the-http-status-code]], [[a-matrix-grant-is-only-gate-one-of-two]],
[[app-visibility-is-application-scoped-not-rls]].
