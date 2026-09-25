---
name: sharp-is-a-devdependency-that-two-production-paths-import
description: "sharp was a devDependency that two live server routes imported; PR #2301 moved it into dependencies on 2026-08-22, and the two importing routes are still the thing to protect"
metadata:
  type: project
---

**RESOLVED 2026-08-22 by PR #2301** (squash `4c1e3bad`, *"chore(deps): sharp is a runtime
dependency, so declare it as one"*). `sharp` now sits in **`dependencies`** on `origin/main`. The
filename of this memory still says "devDependency" — it is kept so the index pointer does not
break; read the resolution, not the name.

Verify before relying on it, because a local checkout is often behind:

```
git cat-file -p origin/main:package.json | awk '/"dependencies"|"devDependencies"/{s=$1} /"sharp"/{print s, $0}'
```

`git show origin/main:package.json` is NOT a substitute here — it returns empty on MSYS
(see [[git-ref-colon-path-is-mangled-by-msys-returns-empty]]).

## What still matters

Two runtime modules import `sharp` as a plain static import, and both are live:

- `src/lib/direct-orders/invoice-scan.ts` — via `app/api/direct-orders/invoice-extract/route.ts`
- `src/lib/hiring-documents/document-scan.ts` — added 2026-08-22 (PR #2298), hiring-document camera

Declaring the dependency fixed the *declaration*, not the packaging. Two separate traps remain and
each one breaks **both** features at once, with no build error and no type error:

- the standalone trace drops the native `.so` a top-level `import sharp` needs
  ([[next-standalone-trace-misses-a-native-librarys-so-dependency]]) — load native modules on
  demand and assert them at build time
- tracing copies FILES, never pnpm's SYMLINKS, so a hoist is required in `pnpm-workspace.yaml`
  ([[next-tracing-copies-files-not-pnpm-symlinks]])

**Why:** the old failure mode was `Dockerfile:22` running `pnpm install --frozen-lockfile` with no
`--prod` and no prune, so dev deps happened to be present at build time and Next traced sharp into
`.next/standalone`. Adding `--prod` would have broken invoice scanning and hiring-document scanning
silently. That specific risk is gone; the packaging risks above are not.

**How to apply:** do not "fix" this by deleting the imports, and do not re-open the dependency
question — it is settled. Treat any change to the Dockerfile install step, to output-file-tracing
config, or to the pnpm hoist patterns as touching two live features, and prove sharp loads **as the
runtime user** rather than at build time. Proven in production 2026-08-22 as `nextjs` (uid 1001):
`RUNTIME_SHARP_OK_bytes=292_libvips_8.18.3`, with a negative control from `/tmp` giving
`Cannot find module 'sharp'`.

Related: [[sharp-extract-then-stats-measures-the-source-image]] ·
[[next-standalone-trace-misses-a-native-librarys-so-dependency]] ·
[[railway-ssh-joins-argv-and-lands-as-root]]
