---
name: next-tracing-copies-files-not-pnpm-symlinks
description: "outputFileTracingIncludes copies real FILES, never pnpm's symlinks, so a traced transitive package still fails to resolve in .next/standalone"
metadata:
  node_type: memory
  type: project
  originSessionId: 84a6d667-0635-4a31-b278-162136c6bbd5
  modified: 2026-08-22T20:05:00.000Z
---

**Adding a package to `outputFileTracingIncludes` does NOT make it requirable.** The globs copy real
files to the same relative path (`collect-build-traces.js`: `glob(pattern, {cwd: dir, nodir: true,
dot: true})` then `path.relative(pageDir, ...)`). **`nodir: true` means no directories and therefore
no symlinks** — and under pnpm, resolution of a TRANSITIVE package depends entirely on symlinks:

- `node_modules/.pnpm/pdfjs-dist@X/node_modules/@napi-rs` → link, this is how pdfjs finds canvas
- `node_modules/.pnpm/@napi-rs+canvas@X/node_modules/@napi-rs/canvas-linux-x64-musl` → link, this is
  how the wrapper finds its own native binary
- `node_modules/@napi-rs/` → **absent**, because a transitive package is never hoisted to the root

Trace the package and standalone gets the bytes at `.pnpm/@napi-rs+canvas@X/node_modules/...` with
**neither link recreated**, so `require('@napi-rs/canvas')` still throws `MODULE_NOT_FOUND`. Proved
2026-08-22 with a fabricated tree: files-only → `MODULE_NOT_FOUND` (production's exact error); the
same package at `node_modules/@napi-rs/canvas` → resolves.

**This burned a production deploy.** PR #2299 (`80d2c908`) added three correct globs — verified
against Next's own compiled glob, 8 files matched, `pdf.worker.mjs` as a passing control — shipped,
and changed nothing: the boot warning was still there 1.6s after `Starting Container`. The globs were
right; the assumption that copied files are reachable was wrong.

**Why `pdf.worker.mjs` works and this does not:** that file is loaded by RELATIVE path from inside
pdfjs's own directory, so no node_modules resolution happens. Any include reached by relative path
works; any include reached by PACKAGE NAME needs a resolvable location.

**FIXED AND CONFIRMED IN PRODUCTION** by PR #2302 (`2bfdf9bd`, live 2026-08-22 22:58 Cairo) — the
boot log carries ZERO `Cannot load "@napi-rs/canvas"` lines where the previous container printed one
at +1.6s. Three parts, all load-bearing:

1. `publicHoistPattern: ["@napi-rs/*"]` in **`pnpm-workspace.yaml`** — pnpm 11 reads settings there,
   NOT from `.npmrc` or `package.json`. Layout only; `pnpm-lock.yaml` is untouched. Changing it makes
   the next `pnpm install` re-link, which needs `CI=true pnpm install --frozen-lockfile` non-interactively.
2. ONE glob, `./node_modules/@napi-rs/*/**`. **`@napi-rs/**` matches ZERO files** — `**` does not
   traverse a symlinked directory. A glob matching nothing looks identical to a working one in review.
3. `scripts/verify-standalone-canvas.mjs`, run in CI right after `next build`: it does the exact
   production resolution, `createRequire(<standalone pdfjs pdf.mjs>).resolve('@napi-rs/canvas')`, and
   fails the build if it throws. This is the check that would have caught #2299.

**The warning's absence proves the NATIVE binary loaded too, not just the wrapper** — `index.js`
line 19 destructures from `./js-binding` at top level, so `require('@napi-rs/canvas')` eagerly loads
the platform `.node`. CI proves gnu; only the production log proves musl.

**How to apply:** to make a name-resolved package survive standalone, hoist it so the walk-up finds
it, glob the root path with `*/**`, and gate it with a post-build resolution check. See
[[railway-deploy-applies-no-migrations]] and
[[next-2mb-data-cache-throws-only-in-dev-and-kills-the-server]].
