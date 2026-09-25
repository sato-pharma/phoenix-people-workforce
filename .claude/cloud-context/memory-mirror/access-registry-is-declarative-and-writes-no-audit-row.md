---
name: access-registry-is-declarative-and-writes-no-audit-row
description: "src/lib/security/access-registry.ts is a test fixture, not runtime — adding an entry changes NOTHING about what a route enforces or logs"
metadata: 
  node_type: memory
  type: project
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-20T23:43:48.954Z
---

`src/lib/security/access-registry.ts` is a **declarative inventory read only by tests and
scripts**. Its consumers are `tests/`, `scripts/security-*.ts`, and the inert
`src/lib/cron-control/job-registry.ts`. **Nothing in the request path imports it.**

Two specific consequences, both of which I got wrong out loud on 2026-08-21:

- `permission: { resource, action }` in an entry does **not** guard the route. The guard is the
  `assertPermission(ctx, resource, action)` call inside the handler. The entry only asserts that
  the handler *ought* to have one.
- `audit: { classification: "mutation", required: true }` does **not** produce an audit row. The
  only thing that writes to `audit_logs` is a `writeAuditLog` / `writeRequiredAuditLog` call in
  the code path. After PR #2239 I told the owner the five Source Normalizer routes "now leave an
  audit trail" — they did not, and still do not.

**Why:** the registry exists so CI can prove every route is *declared*; enforcement and logging
are separate and live in the handler and the domain service. A registry PR is documentation plus
a test net, and it is worth doing, but it must never be described as changing behaviour.

**How to apply:** before claiming a registry change fixed anything, `git grep` for the actual
`assertPermission(` and `writeRequiredAuditLog(` call in the handler or its service. If it is not
there, the gap is still open. See [[how-to-attribute-a-production-write]] for the related trap
that a pure UPDATE leaves no log line at all.

Related: [[payroll-mutations-were-unaudited-until-2026-08-21]].

## Registering a route whose gate lives in the SERVICE (added 2026-08-22)

`tests/access-registry-coverage.test.ts` does not only check that a route is *present*. For a
`session` entry it also greps the handler source, and an entry whose guard is the default
`assert-permission` FAILS unless the file literally contains `assertPermission(` (or one of the
named domain guards). A route that is a thin transport — access enforced inside
`src/lib/<domain>/…` — must therefore declare **`guard: "domain-helper"`, `permission: null`**.
Precedents: `/api/admin/pm-products`, `/api/dev-auth/preview`, and the four
`/api/territory-management/area-consolidation/**` routes.

Two more things the same test enforces, both easy to get wrong:

- `sessionApi` defaults `csrfRequired` to **false** and then silently fills in a blanket
  `exemptReason`. If the handler really does call `assertSameOriginMutation(request)`, pass
  `csrfRequired: true` — otherwise the entry claims an exemption the route does not need. The
  reverse is checked too: declare it required and the source must contain that call.
- Patterns match by segment, `:param` compiling to `[^/]+`, and ties break on **longest pattern**
  — so `…/:areaId/apply` and `…/reverts/:consolidationId` cannot swallow each other, but a
  `/**` blanket will swallow both if one exists. Assert `entry.pattern === route` when you want
  a route to own its entry rather than inherit one.

**Verify a registry change without the full suite** (seconds, no build):

```
node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs --input-type=module -e "const m = await import('./tests/access-registry-coverage.test.ts'); m.runAccessRegistryCoverageTests(); console.log('PASS');"
```

Everything above is about *declaration*. The rule at the top of this file still holds: it changes
nothing at runtime. Check the handler for the real `assertPermission(` / `writeRequiredAuditLog(`
before saying a route is guarded or audited — and grep the branch that actually HAS the file, since
a grep run in a worktree on another branch returns a confident empty result.
