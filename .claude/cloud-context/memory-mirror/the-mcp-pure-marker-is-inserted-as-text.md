---
name: the-mcp-pure-marker-is-inserted-as-text
description: The MCP bundle marked `cache(` pure by string replacement, so a COMMENT reading "row cache (path.ts), generalised:" closed the docblock and esbuild parsed the prose as code — the failure names a line with no code on it.
metadata:
  type: project
---

`infra/phoenix-mcp/build.mjs` inserts `/* @__PURE__ */` into each Phoenix source file as TEXT before
esbuild parses it. Until 23 Oct 2026 it did that with a blind `source.replace(/\b(cache|unstable_cache)\s*\(/g, ...)`,
which also fired inside COMMENTS: the inserted `*/` ended the docblock early, and everything behind
it became code. `src/lib/cache/shared-read.ts` line 10 says "the weekly sales row cache
(src/lib/sales/weekly/row-cache.ts), generalised:" — so `mcp-security` and `static` both failed with
`Expected ";" but found ":"` at `shared-read.ts:10:112`, a line that holds no code at all. Measured
across the 169 bundled files: 13 markers inserted, 3 of them in comments, 10 real calls.

**Why:** the error points at prose and names a file the change never touched, so it reads as the other
session's comment being wrong, or as a pre-existing red on `main`. It is neither — it only appears
when a module whose comment happens to write `cache (` first enters the reader's import graph, which
is why the same file was green until a new import reached it.

**How to apply:** the fix is in `build.mjs` — a single-pass scan that copies comments, strings and
template literals through untouched and marks only real calls; it only ever INSERTS, so a call it
declines to mark stays unmarked and the file's own bundle assertions catch it (fails closed). Never
reword another module's comment to get the bundle green, and never widen the workflow's nine paths
instead: `ci.yml`'s `static` job runs `node build.mjs` on every PR, so this failure takes the
required `checks` gate too. A local proof needs only `npm install --no-save esbuild@0.25.12` inside
`infra/phoenix-mcp` — `packages: 'external'` means nothing else has to resolve. Related:
[[the-mcp-bundle-guard-only-runs-on-nine-paths]].
