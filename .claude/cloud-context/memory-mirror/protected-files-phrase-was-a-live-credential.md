---
name: protected-files-phrase-was-a-live-credential
description: "❌ FULLY REFUTED 2026-08-01 by direct measurement — the old protected-files phrase authenticates NOTHING on staging (0/144, 0/12) OR production (0/144, 0/147), and it is NOT prod's ADMIN_USERNAME as claimed. Nothing is owed; the only rule left is never reuse the string. Filename kept so existing wiki-links resolve."
metadata:
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-01T00:51:26.113Z
---

🔴 **Read this before acting on any older note that calls this a live credential — including the
older paragraphs inside this very file's history and [[staging-is-a-schema-skeleton-not-a-clone]].**

## ✅ Measured 2026-08-01 — the exposure is already closed, by accident

Compared the exact value from `.env.staging.rls.local` against **every** stored hash on staging
(`cifwmndunmlxjhyjugxa`), locally so the value never entered a transcript:

| surface | rows checked | matches |
| --- | --- | --- |
| `public.app_auth_users.password_hash` (all `$2b$`, 60 chars, 0 NULL) | **144 / 144** | **0** |
| `auth.users.encrypted_password` (all `$2a$`, via Postgres's own `crypt()`) | **12 / 12** | **0** |

No false-negative hole: every hash is standard bcrypt, so `bcryptjs` parses all of them, and the
`auth.users` leg used Postgres `crypt()` directly, which is authoritative.

**Why it was never live.** `PHOENIX_RLS_ADMIN_PASSWORD` is an *input* to
`tests/scripts/bootstrap-phoenix-sandbox-auth.ts`, which **creates** a sandbox admin. That script
never completed against staging — `public.employees` has **0** rows named
`"PHX RLS Sandbox Bootstrap Admin"` — and it **refuses to overwrite**: it throws
`"Supabase Auth bridge email already exists without app_auth_users; refusing to overwrite"` and its
`insert into auth.users` has no `on conflict`. So the configured `PHOENIX_RLS_ADMIN_LOGIN_ID`
(`admin-HR`) kept the password it inherited from the 2026-07-11 production restore. The phrase was
a *wish*, never a fact.

🔴 **Corollary: that script is create-only and CANNOT rotate anything.** Don't reach for
`pnpm run db:rls:bootstrap-sandbox-auth` as a rotation tool — it will refuse or no-op.

## ❌ The production leg is ALSO refuted — measured 2026-08-01

The claim "the exact same string is `ADMIN_USERNAME` in `.env.production`" is **false**, and it was
false when written, not stale: `.env.production` was last modified **2026-07-09**, three weeks
before that note. Compared locally (booleans only, values never printed):

| check | result |
| --- | --- |
| phrase `===` `ADMIN_USERNAME` | **false** (both happen to be 9 chars — likely how they got conflated) |
| phrase `===` `ADMIN_PASSWORD` | **false** (that one is 8 chars) |
| prod account with `login_id = ADMIN_USERNAME` | **0 rows** |
| phrase vs prod `app_auth_users` | **0 of 144** (all 144 bcrypt-comparable, 0 unparseable) |
| phrase vs prod `auth.users` via `crypt()` | **0 of 147** |

**And `ADMIN_USERNAME` / `ADMIN_PASSWORD` are dead variables anyway.** No code in the repo reads
either one — every match in the tree is a *prefixed* variant (`PHOENIX_RLS_ADMIN_PASSWORD`,
`SYNTHETIC_ADMIN_PASSWORD`). They are absent from `cloud-run-env.yaml` and absent from the live
`phoenix-hr` service's env, so they never reach production at runtime. Legacy leftovers.

## What IS still true

- The string sits in git history on `main` (introduced by `5bbfadcd`, PR #524; removed from the
  working tree by #1508 / `a098a53a`). History was never rewritten and does not need to be.
- Treat the string as **burned**: never reuse it as a password anywhere, ever. That is the only
  action item left, and it is a rule, not a task.
- 🔴 **Method note:** these comparisons must run in a LOCAL script. Inlining the literal into an MCP
  `execute_sql` would print the credential straight into the session transcript
  ([[gcloud-commands-that-leak-secrets-into-transcripts]]). Read-only `SELECT`s against prod are
  fine; the probe used `POSTGRES_URL` from `.env.production` (pooler `aws-1`, port 5432).

## The real lesson

**"A credential is exposed" and "an exposed credential is live" are different claims, and the second
one is measurable.** Three separate sessions carried this as owed P0 rotation work, blocked it on a
staging DB password that also turned out to be fine, and none of them spent the ten minutes to ask
whether the value authenticated anything. Measure first — a bcrypt compare against every stored hash
is cheap and decisive, and it retires the whole thread.

Related: [[claude-config-audit-2026-07-31]] (the audit this came out of),
[[staging-is-a-schema-skeleton-not-a-clone]] (repaired in place; also carried the stale claim),
[[local-env-already-points-at-production]], [[test-seams-for-supabase-backed-code]].
