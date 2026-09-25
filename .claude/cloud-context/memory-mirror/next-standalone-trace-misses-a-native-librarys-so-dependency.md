---
name: next-standalone-trace-misses-a-native-librarys-so-dependency
description: "Next's standalone tracer copies a native module's JS binding but not the .so it links against, so sharp threw ERR_DLOPEN_FAILED in production while every local check was green"
metadata:
  type: reference
---

**A JS tracer follows `import`/`require`. A `DT_NEEDED` entry inside a compiled `.so` is not an
import, so nothing traces it.** Next's `output: standalone` therefore produced an image containing
sharp's JS *and* its `@img/sharp-linuxmusl-x64` binding, but **not**
`@img/sharp-libvips-linuxmusl-x64`, which ships the `libvips-cpp.so` the binding dlopens:

```
Could not load the "sharp" module using the linuxmusl-x64 runtime
ERR_DLOPEN_FAILED: Error loading shared library libvips-cpp.so.8.18.3: No such file or directory
  (needed by /app/node_modules/.pnpm/@img+sharp-linuxmusl-x64@0.35.3/…)
```

**Why:** on 2026-08-22 this took `/hiring-documents` to HTTP 500 in production (PR #2298; fixed by
#2300). The page did no image work at all — a **top-level** `import sharp` in
`src/lib/hiring-documents/document-scan.ts` sat on its render path via
`page.tsx → service.ts → document-scan.ts`. Nothing local could catch it: lint, typecheck and the
whole test suite were green, because on Windows/glibc sharp loads perfectly. Only the musl image
fails, and CI never builds the image.

The same latent break had been sitting in `src/lib/direct-orders/invoice-scan.ts` for far longer —
it just had no page in front of it.

**How to apply — three separate lessons, in order of value:**

1. **Never put a native module on a page's import path.** Load it inside the function that needs
   pixels (`const sharp = (await import("sharp")).default`). Static ESM imports are hoisted and
   eager; dynamic ones are not. This is what turns "the whole page is down" into "this one photo
   was filed unenhanced". `pdf-lib` needs no native code, so PDF assembly survives a dead sharp.
2. **Fix the image by merging the package in, and delete the traced copy first** —
   `rm -rf /app/node_modules/sharp /app/node_modules/@img` before `cp -R`, because copying over a
   pnpm symlink writes *through* it into the store and leaves the broken resolution in place. The
   `puppeteer-core` block above it in the `Dockerfile` is the same technique.
3. **Assert it at BUILD time**, which is the only place that runs the real image:
   `RUN cd /app && node -e "require('sharp')…"`. A red build beats a 500. This check did not exist,
   which is the whole reason the defect reached production.

**Outcome, 2026-08-22.** Broken 22:04–22:23 Cairo; every one of the 5 logged errors was the
verifying session's own probe, none a user. Fixed by #2300 — `/hiring-documents` 500 → 307, and
`/api/hiring-documents` 500 → 403 (that API surface was down too, not just the page: the same
`service.ts` import reaches every route in the module). **The build-time assertion passing IS the
proof sharp now loads** — the image will not build otherwise. One thing it does NOT prove: the
assertion runs as root at build time, while the server runs as `nextjs`. npm's 644/755 permissions
make that fine in practice, and a failure there degrades to unenhanced pages rather than a crash,
but the first real scan is what confirms it.

Verify a fix like this by reproducing the failure, not by reasoning: an
`--experimental-loader` whose `resolve` throws for `"sharp"` proves the page's module graph really
is clean.

Related: [[sharp-is-a-devdependency-that-two-production-paths-import]],
[[a-broken-rsc-page-still-returns-http-200]] (this one returned 500 — a hard module-load throw, not
a render error), [[railway-merge-is-the-production-deploy]].
