---
name: pdfjs-worker-tracing-gap-fix
description: "Production PDF CV text extraction was hard-failing due to a second Next.js file-tracing gap in pdfjs-dist (sibling to the DOMMatrix one) — PR #1362 MERGED+PROD-LIVE 2026-07-26"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4dc462ab-253f-442c-8cc9-11e9e94d98fb
  modified: 2026-07-26T10:29:22.580Z
---

Production/staging threw `Setting up fake worker failed: Cannot find module '.../pdfjs-dist/legacy/build/pdf.worker.mjs'` on every CV PDF text extraction (`src/lib/recruitment/cv-extraction.ts` → `pdf-parse` → `pdfjs-dist`'s legacy build). This IS fatal, not a harmless fallback warning — in Node, pdfjs-dist always disables real Worker threads and instead dynamically `import()`s its own sibling `pdf.worker.mjs` to run parsing in-process; if that import rejects, the whole `getDocument()`/`getText()` promise chain rejects.

Root cause: same class of bug as recruitment-cv-extraction-dommatrix-polyfill (see `src/lib/recruitment/pdf-dommatrix-polyfill.ts`) — Next's production file-tracer (`.next/standalone`) only follows *static* imports. pdfjs-dist's worker load is a dynamic `import(workerSrc)` deliberately marked `/*webpackIgnore*/ /*@vite-ignore*/`, so the tracer copies the statically-imported `pdf.mjs` but drops the dynamically-loaded `pdf.worker.mjs` sibling.

Fix: added `outputFileTracingIncludes` in `next.config.ts` (`"/api/**/*": ["./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"]`) so Next's tracer explicitly copies the worker file into `.next/standalone`. No Dockerfile change needed (unlike the puppeteer-core precedent) since `outputFileTracingIncludes` is a build-time Next config, not a runtime container step.

Verified locally with a real production-style build (`pnpm run build`, NOT dev) using a synthetic pdfkit-generated CV PDF: confirmed the exact same error reproduces byte-for-byte when the traced worker file is removed, and extraction succeeds once it's present. Full `pnpm run check:harden` (routes/migrations/domain checks, lint, typecheck, test, build) passed.

**Why this matters for future sessions:** if another pdfjs-dist/pdf-parse-adjacent crash shows up in production with a `/app/node_modules/.pnpm/...` path in the error, check `outputFileTracingIncludes` in `next.config.ts` first — this is now the established pattern for "file exists in dev node_modules but Next's tracer drops it because the reference is dynamic."

**How to apply:** [PR #1362](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1362) merged to `main` 2026-07-26 (squash commit `d769e87b`), user explicitly approved the merge knowing it triggers production deploy. The Cloud Run production deploy workflow ran (new revision → smoke test → promoted to 100% traffic) and completed clean. Verified post-deploy: `https://phoenix-hr.satopharma.com` renders the login page with no console errors, and no new Sentry issues appeared on project `phx-b9` after the deploy. Did NOT do a full authenticated end-to-end CV-upload test against production (would touch real candidate data) — relied on the byte-for-byte local reproduction (see above) plus a clean automated smoke test as the evidence bar.
