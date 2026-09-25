---
name: app-visibility-is-application-scoped-not-rls
description: "Data visibility in this app is enforced in APPLICATION code through the service-role client (359 files under src/) — RLS is a backstop reached by only 3 modules. Changes the risk assessment for anything touching auth/session, and hides a silent fail-open on payroll."
metadata:
  node_type: memory
  type: project
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-08-01T01:46:00.163Z
---

Measured 2026-08-01 while verifying the `@supabase/supabase-js` 2.110.8 bump.

| client | files under `src/` |
| --- | --- |
| `getSupabaseAdmin` — service_role, **bypasses RLS entirely** | **238** |
| `getSupabaseUserClient` | 2 |
| `getSupabaseRlsClient*` | 4 (only `payroll/service.ts` + `outstation/expenses.ts`) |

**So "who can see what" is decided by explicit filters in app code, not by row-level security.**
RLS exists as a backstop against direct PostgREST access, which is why the anon-grant revokes matter
— but it is not the mechanism the app relies on.

## Why this matters before you reason about a change

Any question of the form *"could this break data visibility?"* has to start here. A session/auth
regression **cannot** affect the CRM or portal surfaces — they never carry a user session at all.
This retires a whole class of worry that was previously assumed (a dependency bump was held for a
week partly on the belief that it could silently change what a Medical Rep sees; it could not).

## 🔴 The silent fail-open

Both RLS call sites read:

```ts
const supabase = await getSupabaseRlsClientIfAvailable() ?? getSupabaseAdmin();
```

`getSupabaseRlsClientIfAvailable()` wraps `getSupabaseRlsClient()` in `try/catch` and returns
**null on ANY error** — including a failed `supabase.auth.setSession(...)`. So if session hydration
ever breaks, nothing throws: every one of those reads quietly runs as **service_role**, and RLS
stops applying.

That matters because those callers do not filter for themselves. `listSalaryBatches()` is a bare
`.select("*")` on `salary_batches` with no user predicate — RLS is the *only* thing scoping it. A
setSession regression would turn it into "every salary batch, for anyone who reaches the route".

**Verified 2026-08-01: not currently triggered.** supabase-js 2.110.8 propagates the session —
after `setSession`, the REST call carries `Authorization: Bearer <user jwt>`, not the anon key.
But nothing in the codebase would *tell you* if that changed; there is no test and no log line.
If you touch supabase-js, the auth cookies, or `rls-server.ts`, re-check this specific behaviour.

## How to apply

- Before claiming a change affects what a role can see, check which client the read path uses.
  238-to-2 odds say it is service_role and the scoping is a filter you can read in the code.
- Treat `?? getSupabaseAdmin()` as a security-relevant fallback, not a convenience. If you add one,
  make the caller filter for itself so the degraded path is still correct.
- The app ships **no** Supabase host to the browser bundle — useful to know, and it means you cannot
  tell which project a running server points at by inspecting the served HTML/JS.

Related: [[test-seams-for-supabase-backed-code]], [[local-env-already-points-at-production]],
[[staging-is-a-schema-skeleton-not-a-clone]] (where the supabase-js hold was recorded).

## 2026-09-04 — re-measured, and the ratio got starker

| symbol | measured 2026-08-01 | live 2026-09-04 |
| --- | --- | --- |
| `getSupabaseAdmin` (service role) | 238 files | **359** files |
| `getSupabaseUserClient` | 2 | **2** |
| `getSupabaseRlsClientIfAvailable` | 3 modules | **3** modules |

Service-role usage grew by half while the RLS-scoped paths did not move at all. The conclusion is
the same one, only harder: **changing auth or sessions will not move what a user can see.**

**Measure like for like or you will manufacture a finding.** The 238 was measured under `src/`
alone. The same grep across `src` **and** `app` returns **391**, and a looser client pattern
returns 398 — three defensible numbers for one question. A "figure has drifted" claim is only worth
making once the scope matches the scope that produced the original.
