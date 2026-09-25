---
name: running-vacation-service-standalone-needs-an-extended-loader
description: "scripts/alias-loader.mjs cannot load most domain services standalone — it misses next/cache and cannot strip types from the .tsx email templates they transitively import"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 26968de2-24de-4b16-a339-4065a48eba87
  modified: 2026-08-21T00:32:11.474Z
---

To run a real domain service against staging (the way every "prove it on staging" harness does), the
repo pattern is:

```
node --experimental-strip-types --experimental-specifier-resolution=node \
     --experimental-loader ./scripts/alias-loader.mjs <script>.ts
```

**That loader is not enough for most services.** It hard-codes only `next/server` and `next/headers`,
so anything importing `next/cache` (`revalidatePath`/`revalidateTag` — the vacation, payroll and
sales services all do) dies with `ERR_MODULE_NOT_FOUND: .../node_modules/next/cache`, and the hint
"Did you mean next/cache.js" is the whole fix. Then Node hits `ERR_UNKNOWN_FILE_EXTENSION ".tsx"` on
`src/emails/*.tsx`, because type stripping handles `.ts` and **not** `.tsx`.

`scripts/phase15-tsx-email-stub-loader.mjs` already solves the second half, but its stub exports a
**hard-coded** list of names — a template exporting anything else fails at import. Deriving the names
from the real file (`/^export\s+(?:async\s+)?(?:function|const|let|class)\s+(\w+)/gm` plus
`export { … }`) makes it general. Only email *rendering* is stubbed; no business-logic path is
replaced.

**Why:** these loaders were each written for one script and never generalized, so every new harness
rediscovers both failures.

**How to apply:** copy the extended loader into the scratchpad rather than editing
`scripts/alias-loader.mjs` — that file is shared and other sessions are usually live in the same
checkout. Do **not** add `--env-file-if-exists=.env.local`: it points at PRODUCTION
([[local-env-already-points-at-production]]). Pass staging credentials inline from
`railway variables --environment staging --service phoenix-people-workforce --kv` and guard the
script on the project ref. A worktree cannot run any of this — `git worktree add` never creates
`node_modules` ([[bare-worktree-cannot-push-pre-push-gate-needs-node-modules]]), so run from the main
checkout after proving the files there are identical to `origin/main`.
