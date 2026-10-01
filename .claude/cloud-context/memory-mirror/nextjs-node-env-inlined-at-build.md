---
name: nextjs-node-env-inlined-at-build
description: "Next.js/Turbopack inlines process.env.NODE_ENV to a build-time literal in server code too — any NODE_ENV runtime guard in route handlers is dead code on Vercel/CI builds."
metadata: 
  node_type: memory
  type: project
  originSessionId: 70bee4de-4487-4be5-9293-408d62f53dd8
---

In this repo's Next.js 16 + Turbopack build, `process.env.NODE_ENV` is NOT a live
runtime read anywhere in compiled output — client, edge, **and Node.js server**
bundles alike. Next's `getDefineEnv` (`node_modules/next/dist/build/define-env.js`)
sets `'process.env.NODE_ENV': dev ? 'development' : 'production'` unconditionally
(not gated by `isClient`/`isNodeServer`), so `next build` (used for every Vercel
deployment — production AND preview — and for CI's `preview-smoke` job, which
downloads the build artifact and serves it via `next start`) permanently bakes
`NODE_ENV` in as the literal string `"production"`. The literal text `"NODE_ENV"`
does not even appear in the compiled chunk — verified by grepping
`.next/server/chunks/*.js` after a real `npm run build`.

**Consequence:** any `process.env.NODE_ENV !== "production"` guard written inside
server/route code becomes a compile-time-constant `false` in every built
deployment, indistinguishable between real production and a CI/preview build. It
silently defeats itself as "dead code" rather than throwing — easy to ship
believing it works. This also means the existing pattern in
`src/lib/security/origins.ts`
(`NODE_ENV !== "production" || PHOENIX_CI_SMOKE_LOGIN === "true"`) is weaker than
it looks: on Vercel the NODE_ENV clause is always false too, so it only actually
differs from "always production" under local `next dev`.

**Why:** discovered while fixing a security-audit finding on
`app/api/auth/login/route.ts`'s hardcoded CI smoke-login bypass
(`PHOENIX_CI_SMOKE_LOGIN=true` → logs in as `a-12`/`12345678`, National Sales
Manager). The audit's suggested remediation ("add a NODE_ENV!=="production" guard
like the sibling in origins.ts") would have compiled away to always-false in the
exact build artifact CI's login smoke test depends on, breaking CI while looking
like a correct fix in code review.

**How to apply:** for any future runtime-environment guard in Next.js server code
(API routes, server components, "block this in real production" logic), do NOT
use `process.env.NODE_ENV`. Use `process.env.VERCEL_ENV` instead — Vercel
auto-injects `"production"` / `"preview"` per deployment (unset in GitHub Actions
CI), it is not inlined by Next's DefinePlugin (confirmed live in compiled output:
`"production"!==process.env.VERCEL_ENV`), and it can't be fat-fingered the way a
manually-configured project env var can. Always verify a proposed env-based guard
by running a real `npm run build` and grepping the compiled
`.next/server/chunks/*.js` for the variable name — don't trust source-level
reasoning alone for anything touching `NODE_ENV` in this codebase.
