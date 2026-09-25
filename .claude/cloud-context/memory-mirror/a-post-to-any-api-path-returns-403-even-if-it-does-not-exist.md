---
name: a-post-to-any-api-path-returns-403-even-if-it-does-not-exist
description: "Every unauthenticated POST to /api/** returns 403 in production — including to paths that do not exist — so a 403 NEVER proves a new API route deployed. An unauthenticated GET discriminates (404/405/403) EXCEPT under /api/admin/**, where a nonexistent path ALSO returns 403"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
  modified: 2026-08-23T05:13:16.627Z
---

Measured live against `https://phoenix-hr.satopharma.com`, 2026-08-23, while verifying the
evidence-stamp deploy (PR #2309).

The same-origin/CSRF guard runs in **middleware, before routing**, so it answers every
unauthenticated POST identically — the router never gets to decide whether the path exists:

```
POST /api/direct-orders/reverse-geocode      -> 403
POST /api/direct-orders/definitely-not-a-route-xyz -> 403
POST /api/zzz-no-such-module/zzz             -> 403
POST /api/healthz                            -> 403   (exists, but is GET-only)
```

**So "unauthenticated POST returned 403, therefore my new route is deployed and its gate fires" is
not evidence of anything.** It is the answer for a route that shipped, a route that did not ship,
and a route that never existed. The temptation is strong because 403 *looks* like a permission gate
firing — it is a CSRF gate firing, one layer earlier.

**GET does discriminate**, and is the probe to use:

| Unauthenticated GET | Meaning |
| --- | --- |
| `404` | the route file is not deployed (or the path is wrong) |
| `405` | the route file IS deployed but has no GET export — the cleanest proof for a POST-only route |
| `403` | deployed, has a GET, and its permission gate fired |

Worked example — `/api/direct-orders/reverse-geocode` is POST-only, so before its deploy the GET
returned `404` and after it returned `405`. No auth, no cookie, no dev-auth header needed.

Two limits on this:

- `405` only distinguishes when the route genuinely lacks the method you probe. A route exporting
  both GET and POST gives `403` either way, and then you are back to `/api/healthz` `revision`.
- **The authoritative deploy check is still `/api/healthz` `revision`** — see
  [[railway-deploy-applies-no-migrations]] and [[railway-auto-deploy-can-silently-skip-a-race]].
  The GET probe answers "did this specific route file ship", which `revision` alone does not when
  you want to be sure the right build shipped.

Related but a DIFFERENT trap: [[a-role-probe-cannot-trust-the-http-status-code]] is about GET
**pages**, where `redirect()` after the shell streams returns 200 with a meta-refresh. This one is
about **API routes** and POST specifically.

## 2026-09-03 — the GET probe does NOT discriminate under `/api/admin/**`

The GET table above holds for `/api/direct-orders/**`. It does **not** hold for `/api/admin/**`.
Measured live against `https://phoenix-people-workforce-production.up.railway.app` while verifying
the #2963 deploy:

```
GET /api/admin/outstation/requests            -> 403
GET /api/admin/outstation/does-not-exist-xyz  -> 403   <- the control, and it FAILED to discriminate
GET /api/admin/payroll/approvals              -> 404
```

An admin-scoped gate runs before routing on that prefix, so a nonexistent admin path answers 403
exactly like a real one. **I ran this smoke expecting the documented 404 control, got 403, and very
nearly reported "403 = module loaded, auth rejected" as a passing check.** It proves nothing there.

The same probe on `/api/admin/**` a fortnight earlier (#2960, 2026-08-xx) DID return 404 for a
nonexistent sibling, which is what made it meaningful then. Do not assume it still does — **always
run the nonexistent-path control in the same batch and discard the whole smoke if the control does
not 404.** A control that returns the same status as the subject is a broken instrument.

For an admin route, fall back to `/api/healthz` `revision` plus reading the shipped source out of
the serving commit (`git show <served-sha>:<path>`), which is what actually verified #2963.
