---
name: pr24-supabase-bridge-prod-lockout
description: "RESOLVED 2026-06-07 AND Vercel-era, so doubly dead - do not act on it. Production was briefly pinned to b0b6ca19 because the Supabase bridge locked privileged login out; the claim that any push to main re-breaks login has not been true since. Kept for one live lesson: a local main checkout can lag origin/main, so run git rev-parse origin/main before reasoning about what is deployed."
metadata: 
  node_type: memory
  type: project
  originSessionId: 855cb7f2-5b6e-4c41-9c7c-f91e5219c5de
---

**UPDATE 2026-06-07 — RESOLVED / STALE.** Production no longer pinned to
`b0b6ca19`. Vercel now auto-deploys `main` to production normally: the live
production deployment is `main` HEAD (e.g. `1233fc8`, PR #39), target=production,
READY, and privileged login works (the prod lockout was fixed — strict bridge
disabled or bridge provisioned). So "any push to main re-breaks login" below is
**no longer true**. Note: local `main` checkout can lag `origin/main` (verify
`git rev-parse origin/main` before reasoning about what's deployed). Also: as of
2026-06-07 production `main` carries a **parallel vacation-approval pilot** (steps
direct_manager + manager_of_manager + HR B-10/admin-HR).

**2026-06-03 incident.** Merging PR #24 `codex/ceo-staging-rebuild-hardening`
into `main` (merge commit `db16663c`) and letting it deploy to production
**broke privileged login**: `POST /api/auth/login` returns 503
`auth_bridge_unavailable` — "Login temporarily unavailable for this role.
Please contact your Phoenix admin." Resolved by **`vercel rollback`** to the
last-good prod build `b0b6ca19` (deployment `abd6veb6f`). Login restored.

**Mechanism** (`app/api/auth/login/route.ts` + `src/lib/auth/app-sessions.ts`):
`shouldBlockLoginWhenSupabaseBridgeUnavailable(role)` blocks login for
privileged roles (`isSupabaseBridgeRequiredForRole`) when no Supabase auth
session can be created AND (`PHOENIX_STRICT_SUPABASE_BRIDGE === "true"` OR
`VERCEL_ENV === "production"`). PR #24's hardening enforces this; production's
Supabase Auth isn't provisioned for the bridge, so every privileged login (Super
Admin/CEO/etc.) 503s. The previous prod build `b0b6ca19` didn't enforce it.

**State after rollback:** `main` = `db16663c` (has PR #24); production alias
pinned to `b0b6ca19`. ⚠️ **Any new push to `main` auto-deploys and RE-BREAKS prod
login.** Do not redeploy main until fixed.

**To fix before re-deploying PR #24 to prod:** either set
`PHOENIX_STRICT_SUPABASE_BRIDGE=false` in production Vercel env (restores
Phoenix-only sessions for privileged roles, pre-hardening behavior), OR provision
the Supabase Auth bridge for production users. Verify privileged login on a
preview/staging that mirrors prod env BEFORE promoting.

**Second incident (same day): backporting the feature to old prod LEAKS data.**
Tried Path 2 — cherry-picked Database Mapping onto the production commit
`b0b6ca19` (which is **37 commits behind** the feature branch; `origins.ts` and
`access-registry.ts` don't even exist there). It built fine, but on that old
auth base `GET /api/sales/database-mapping/regions` returned master data
**UNAUTHENTICATED** (old `resolveAccessContext`/`assertPermission` is permissive
for guests where the modern codebase returns 403). Closed within minutes:
re-aliased prod back to `abd6veb6f` (b0b6ca19) + `vercel remove`d the leaky
deployment + deleted the `codex/database-mapping-prod` branch. **Conclusion: do
NOT backport this feature onto the old production base — its auth enforcement
depends on the modern codebase.** It must ship on the modern PR #24 code (where
unauth → 403, verified). Also: `vercel rollback` pins the canonical alias, so a
later `vercel --prod` does NOT auto-update `phoenix-workforce.vercel.app` — must
`vercel alias set` explicitly (and verify the public domain, per AGENTS).

**Team soft-launch link (2026-06-03):** `https://phoenix-workforce-team.vercel.app`
serves the modern codex code on REAL production data, all roles can log in, official
domain untouched. How it was built (repeat to refresh after new edits):
`vercel deploy --prod --skip-domain --yes -e PHOENIX_STRICT_SUPABASE_BRIDGE=false -e PHOENIX_ALLOWED_ORIGINS=https://phoenix-workforce-team.vercel.app --scope phoenix-workspace-s-projects`
then `vercel alias set <new-deployment-url> phoenix-workforce-team.vercel.app`.
`--skip-domain` keeps it OFF the canonical domain; `STRICT_SUPABASE_BRIDGE=false`
makes privileged login work on a production-target build; `ALLOWED_ORIGINS` adds the
team alias so CSRF/login isn't blocked. To update: commit edits, re-run the deploy,
re-point the alias. The team works on real data (not a sandbox) — writes are permanent.

**Lesson:** PR #24 is a staging-rebuild branch; it is NOT production-ready as-is
(auth-bridge + possibly pending prod migrations). To ship the **Database Mapping**
feature ([[source-of-sales-rebuild-rules]]) to prod safely, put ONLY its commits
(4be6de16, 4b43f5b3, 6d8ea7ea; origins fix 2cabd25e optional) on a clean branch
off the working production commit — do NOT ship all of PR #24. Also note local
`.env.local` points at PRODUCTION ([[supabase-dual-project-schema]]).
