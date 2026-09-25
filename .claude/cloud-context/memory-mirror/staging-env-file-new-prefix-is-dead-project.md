---
name: staging-env-file-new-prefix-is-dead-project
description: "In .env.staging.rls.local the PHOENIX_NEW_STAGING_* vars point at the DEAD staging project, not the current one — the \"NEW\" prefix is historically inverted"
metadata: 
  node_type: memory
  type: reference
  originSessionId: fa0c8467-99ea-42eb-a3d2-f3c8f609718f
  modified: 2026-07-31T16:24:36.139Z
---

Local `.env.staging.rls.local` (gitignored, so invisible to any repo search) defines **two**
staging credential sets, and the one whose name says "NEW" is the **dead** project:

| Var prefix | Project ref | Status |
| --- | --- | --- |
| `PHOENIX_STAGING_SUPABASE_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | `cifwmndunmlxjhyjugxa` | **current staging** ✅ |
| `PHOENIX_NEW_STAGING_SUPABASE_URL` / `_ANON_KEY` / `_SERVICE_ROLE_KEY` | `izhmxvgiktiafqusolot` | **decommissioned** ❌ |

**Why:** the prefix is a fossil of the 2026-07-11 staging migration — at that moment
`izhmxvgiktiafqusolot` *was* the new sandbox. It later died and `cifwmndunmlxjhyjugxa` took over
under the plain `PHOENIX_STAGING_*` name, leaving the naming inverted forever. Anyone reading the
env file top-down, or writing a `??` fallback chain that assumes "NEW beats old", silently selects
a service-role key for a project that no longer resolves. `scripts/seed-vlookup-master.mjs` had
exactly that bug (fixed in PR #1398).

**How to apply:** never order staging env fallbacks by how new the *name* sounds — prefer
`PHOENIX_STAGING_*`, treat `PHOENIX_NEW_STAGING_*` as last-resort legacy. Better, resolve URL and
key as a **matched pair** and verify the key really belongs to the target: legacy Supabase
service-role keys are JWTs whose payload carries a `ref` claim, so
`JSON.parse(Buffer.from(key.split(".")[1], "base64url")).ref` proves the project without ever
logging the secret. Newer opaque `sb_secret_*` keys have no embedded ref — warn, don't hard-fail,
or key rotation breaks the script.

Note `PHOENIX_NEW_STAGING_DATABASE_URL` (used by `scripts/sync-sales-pharmacy-codes-into-marketing.ts`)
was a *separate* var with the same misleading prefix — it pointed at
`postgres.izhmxvgiktiafqusolot @ aws-0-eu-west-1.pooler.supabase.com`.

**RESOLVED 2026-07-27.** All five `PHOENIX_NEW_STAGING_*` entries (ENVIRONMENT, SUPABASE_URL,
SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL) were deleted from
`.env.staging.rls.local` (23→18 vars; backups `.bak-20260727` / `.bak2-20260727` in the repo root,
gitignored by `.env*`). `PHOENIX_APPROVED_STAGING_REF` was repointed
`izhmxvgiktiafqusolot`→`cifwmndunmlxjhyjugxa`. Consequence: `scripts/staging-safe-rebuild.ts`'s
`--*-new-staging` modes now throw on missing env — harmless, their target project is dead.
The file is UTF-8 **with BOM** + CRLF; edit it with a script that preserves both, not `sed -i`.

## Third dead ref: `oaifhavixhdtwmseshff` — do NOT blanket-replace

A *different* retired sandbox (belonged to account `sato.hr2@hotmail.com`, not on this account).
It ~~is~~ **was** the repo-wide default in ~9 files as `const approvedSandboxRef = "oaifhavixhdtwmseshff"` **[CORRECTED 2026-08-27: `git grep approvedSandboxRef` now returns ZERO hits — the const is gone from the tree entirely. The phase24–26 smokes retain only explanatory comments naming the retired sandbox. The do-not-blanket-replace warning below is therefore historical.]**
(phase24–27 smokes, `staging-executive-dashboard-migration-reconciliation.ts`,
`prepare-staging-rls-test-users.ts`, `phoenix-staging-role-alignment-runner.ts`,
`bootstrap-phoenix-sandbox*.ts`), and **5 guard tests pin the literal**
(`tests/phase2[4-7]-*.test.ts`, `tests/staging-executive-dashboard-migration-reconciliation.test.ts`).

**Why it's not urgent:** the gate is **fail-closed**. Scripts compare the configured staging
hostname against `<approvedRef>.supabase.co`; a stale default never matches, so it refuses rather
than targeting anything wrong. It only produces a confusing error.

**The trap:** in `tests/scripts/phoenix-production-role-alignment-preflight.ts` and
`phoenix-production-rls-gap-closure.ts` the same literal is a **blocklist** value — a ref those
scripts must REFUSE. A blanket find-and-replace would invert a production safety check.

**SWEPT + MERGED 2026-07-27 — PR #1398, squash `0d1ffbc8` on main (17 files).** All 10 allowlist-gate sites now require
`PHOENIX_APPROVED_STAGING_REF` (no default, throws a named error). The 5 guard tests that pinned
the literal now assert the inverse: `PHOENIX_APPROVED_STAGING_REF is required` present AND
`= "oaifhavixhdtwmseshff"` absent. Regression-proved by reintroducing the literal and watching
phase25 fail.

**STILL HARDCODED ON PURPOSE — never "fix" these two:**
`tests/scripts/phoenix-production-role-alignment-preflight.ts` and
`tests/scripts/phoenix-production-rls-gap-closure.ts`. There `sandboxRef` is a **blocklist** value
those scripts must REFUSE; replacing it inverts a production safety check.
`tests/workflow-control-migration-readiness.test.ts` also keeps the literal — it asserts a SQL
migration contains no project refs at all, which is unrelated and still correct.

See [[agents-md-stale-staging-ref]].
