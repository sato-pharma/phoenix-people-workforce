---
name: a-matrix-grant-is-only-gate-one-of-two
description: "A role holding `resource: [\"read\"]` in defaultPermissionMatrix may still be redirected away — the organogram has a SECOND hand-maintained role list, and three roles have shipped granted-but-bounced"
metadata: 
  node_type: memory
  type: project
  originSessionId: 76790e1c-f7b7-4d3e-a6a2-edce4aff525f
  modified: 2026-08-22T15:56:12.672Z
---

`defaultPermissionMatrix` in `src/lib/auth/permissions.ts` is **gate one of two.** For the
organogram, gate two is a hand-maintained role list in the domain module —
`canAccessCompanyOrganogram` / `isLineScopedOrganogramRole` in `src/lib/reports/organogram.ts`.

A role named in gate one but missing from gate two passes `canAccess(...)` and is then
`redirect()`ed by the page. **Granted on paper, bounced in practice** — no error, no log, no
sign anywhere that the grant is inert.

**Three roles have shipped in exactly that state**, each found only when a human complained:

| Role | grant existed | fixed |
| --- | --- | --- |
| SFE Manager | yes | 2026-08-02 |
| Finance Manager | yes | 2026-08-10 |
| District Manager | yes, since forever | 2026-08-22, PR #2294 |

**Why:** the two lists are maintained by hand, in different files, with nothing tying them
together — no test cross-checked "granted ⇒ reachable" until PR #2294. The matrix reads like the
whole answer, so every session that consults it alone gets a confidently wrong result.

**How to apply:** never answer *"can role X see page Y"* from the matrix, from a nav config, or
from reading either list — **evaluate both gates for every role at once.** Cheap, no build, no
dev server, no database (the matrix override load fails without a service key and falls back to
the compiled-in default, which is the layer you want):

```
node --experimental-strip-types --experimental-specifier-resolution=node \
  --experimental-loader ./tests/alias-loader.mjs /path/to/probe.mjs
```

Two traps in writing that probe: import via the **`@/` alias**, never a relative path (relative
resolves against the script's own directory, not the repo); and the deferred-tool/nav layer wants
`resolveEmployeePortalNavVisibility(role)`, which is a third, separate list again.

Two more things this cost me on 2026-08-22, both worth reusing:

- A regex block-parser over `permissions.ts` reported **CEO has no organogram grant**, which is
  false. Role keys are **not uniformly quoted** — `"Super Admin": {` but `CEO: {` — so a
  `"CEO": \{` pattern silently matches nothing and a missing block reads as a missing grant.
  Evaluate the real functions; do not parse the file.
- In the portal nav layer, `isDistrictManager` **also matches the legacy Head-Office `"Manager"`
  rung**, which holds no organogram grant. Flags there must spell
  `resolvedRole === "District Manager"` exactly, or Manager gets a link that bounces. The file
  documents this twice for other tabs — follow that idiom, it is not decoration.

Related: [[access-registry-is-declarative-and-writes-no-audit-row]] (the mirror-image trap — a
registry entry that declares a permission enforces nothing), [[organogram-chart-source-is-au-seat-model-not-directory]],
[[never-change-the-organogram-skeleton]].
