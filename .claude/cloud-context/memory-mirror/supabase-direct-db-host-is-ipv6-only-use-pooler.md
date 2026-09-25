---
name: supabase-direct-db-host-is-ipv6-only-use-pooler
description: "`db.<ref>.supabase.co` has NO IPv4 record for either Phoenix project — any direct Postgres connection dies with `getaddrinfo ENOTFOUND`. Use the session pooler; staging is aws-0, production is aws-1."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9174dff8-a94f-4187-b303-cb8cdbd5e8f3
  modified: 2026-07-31T19:41:08.826Z
---

Any script that opens a direct Postgres connection (`postgres`/porsager, `psql`, Supabase CLI
`db push`) fails on this machine with:

```
FAIL getaddrinfo ENOTFOUND db.cifwmndunmlxjhyjugxa.supabase.co
```

**It is not a dead project, a wrong ref, or bad credentials.** Verified 2026-07-31:

| Host | A (IPv4) | AAAA (IPv6) |
| --- | --- | --- |
| `db.cifwmndunmlxjhyjugxa.supabase.co` (staging) | **none** | `2a05:d014:700:dc00:…` |
| `db.ozucdzovmcqvepbozvqf.supabase.co` (production) | **none** | present |

The host resolves fine over IPv6; this machine has no usable IPv6 route, so `getaddrinfo` finds no
address and throws. (An older note said these hosts "no longer resolve" — not quite: they resolve,
just AAAA-only. Same outcome, but don't go hunting for a deleted project.)

## The fix — use the session pooler

```
postgresql://postgres.<REF>:<PASSWORD>@aws-<N>-eu-central-1.pooler.supabase.com:5432/postgres
```

⚠️ **The `aws-N` prefix is NOT the same for both projects** — confirmed by DNS, and an earlier
memory claiming "aws-0 for both" is wrong:

| Project | Ref | Pooler host |
| --- | --- | --- |
| **Staging** | `cifwmndunmlxjhyjugxa` | `aws-0-eu-central-1.pooler.supabase.com` |
| **Production** | `ozucdzovmcqvepbozvqf` | `aws-1-eu-central-1.pooler.supabase.com` |

Don't hand-edit the prefix — copy the string from Supabase Dashboard → Settings → Database →
Connection string → **Session pooler**.

- **Port 5432 (session), never 6543 (transaction).** DDL and multi-statement work need session mode.
- **Username must be `postgres.<ref>`**, not bare `postgres`. The repo's own safety gate enforces
  this (`bootstrap-phoenix-sandbox-auth.ts` accepts either the direct host or a URL containing
  `postgres.<approvedRef>`), so a correctly-formed pooler URL passes the sandbox check unchanged.

## Two traps once you're connected

1. **A wrong password reports as `password authentication failed for user "postgres"`** — the
   pooler strips the `.<ref>` suffix when naming the user. **Do not** conclude your username format
   is broken and start editing the URL; if the string contains `postgres.<ref>`, the format is
   right and the *password* is wrong. Reset it in Dashboard → Settings → Database.
2. **porsager `postgres(url)` does NOT URL-decode the password.** A password containing `$`, `@`,
   `%` etc. must be parsed via `new URL` + `decodeURIComponent` into explicit params, or run
   through the Supabase CLI which does decode. See [[delta3-region-carveout]].

## Where this bites

`PHOENIX_STAGING_DATABASE_URL` in `.env.staging.rls.local` and `PHOENIX_PRODUCTION_DATABASE_URL`
in `.env.production.rls.local` — i.e. every `db:rls:*` script, `scripts/staging-safe-rebuild.ts`,
and the verification gate of the planned staging rebuild
([[staging-is-a-schema-skeleton-not-a-clone]]). Supabase **MCP** tools are unaffected — they go
over HTTPS to the API host, which has normal IPv4.

Related: [[territory-management-module-plan]] (hit this first, during the 1,142-row brick move),
[[local-env-already-points-at-production]], [[prod-mcp-token-owns-staging-supabase]].
