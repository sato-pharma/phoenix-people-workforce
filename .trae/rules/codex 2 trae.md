This is Phoenix Workforce, a Next.js 16 / React 19 / Supabase workforce operations app.

Before any Next.js code change:
- Read the relevant guide in node_modules/next/dist/docs/.
- Do not rely on old Next.js training data.
- Route handlers live in app/**/route.ts.
- Next.js 16 uses proxy.ts, not middleware.ts.

Safety:
- Never expose SUPABASE_SERVICE_ROLE_KEY or secret env vars to client code.
- Never put service-role logic in client components.
- Prefer user-scoped Supabase clients unless a server-only admin task is required.
- Do not change SQL/RLS without explaining risk and verification.
- Do not use production database mutations unless explicitly approved.

Workflow:
- Search with rg first.
- Keep changes small.
- Preserve existing UI style.
- After edits run: npm run lint, npm run typecheck, npm run test.
- For release-sensitive changes also run: npm run build.