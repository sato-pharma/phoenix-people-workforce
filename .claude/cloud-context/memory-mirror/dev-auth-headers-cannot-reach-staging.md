---
name: dev-auth-headers-cannot-reach-staging
description: "PHOENIX_ENABLE_DEV_AUTH_HEADERS=true is set on staging but dev-auth headers still 307 to /login — the gate also demands NODE_ENV=development AND a localhost host, so a staging page can never be rendered this way"
metadata:
  node_type: memory
  type: project
  originSessionId: fdc61139-f675-4568-a97b-58356ad4027f
  modified: 2026-10-09T01:17:09.616Z
---

Staging carries `PHOENIX_ENABLE_DEV_AUTH_HEADERS=true`, so a session reasonably expects
`x-phoenix-role` / `x-phoenix-hr-id` to work against
`https://phoenix-people-workforce-staging.up.railway.app`. They do not: the request answers
**307 → `/login`**.

`isLocalDevHeaderRequest` in `src/lib/auth/server.ts` needs **three** things, not one:

- `PHOENIX_ENABLE_DEV_AUTH_HEADERS === "true"` — set on staging, and the only one that is;
- `isLocalDevelopment()`, i.e. `NODE_ENV === "development"` — **false on staging**, which is a
  production build;
- `isLocalDevelopmentRequest()`, i.e. an `x-forwarded-host` or `host` of `localhost`, `127.0.0.1`
  or `::1` — also false for the Railway domain.

So the variable on staging grants nothing on its own, and the two remaining conditions can only be
met by a dev server on this machine. The variable is on production's forbidden list
(`tests/railway-secret-policy.test.ts`), which is a separate guard and not what blocks staging.

**The cookie route is shut the same way, and measured shut.** `GET /api/dev-auth?role=<Role>` — the
other dev-preview entry point — gates on `isLocalDevelopmentRequest` in `src/lib/auth/dev-preview.ts`,
which likewise demands `NODE_ENV === "development"` *and* a loopback hostname, and returns
`{"error":"not_found"}` with status 404 otherwise. Measured against staging 2026-10-09:
**HTTP 404**. So neither the header path nor the cookie path reaches a staging page.

**How to apply:** a role sweep or a "look at the rendered page" check runs against a **local** dev
server, never against staging — there is no header route into a staging page, and signing in there
is not an option a session has. When the thing to verify is a staging-only build (for example a
`NEXT_PUBLIC_*` flag baked at build time), verify it from the layers that are reachable instead:
the variable's post-image, the deployment's state and serving revision, the code path the flag
selects, and the RPC's own output queried directly — then say plainly that the rendered page was
not seen. Related: [[the-roi-fast-rpc-needs-its-own-defaults-not-nulls]].
