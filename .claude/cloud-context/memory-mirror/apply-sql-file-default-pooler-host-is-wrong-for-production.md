---
name: apply-sql-file-default-pooler-host-is-wrong-for-production
description: "scripts/apply-sql-file.mjs rewrites production's direct URL to aws-0-eu-central-1 and it does not resolve — production's pooler is aws-1-eu-central-1; staging really is aws-0."
metadata: 
  node_type: memory
  type: project
  originSessionId: 3e941c10-91bd-467d-a55c-3032b8073574
  modified: 2026-09-22T19:16:37.982Z
---

`scripts/apply-sql-file.mjs` applies a .sql file over the pooler. **Its `DEFAULT_POOLER_HOST` is
`aws-0-eu-central-1.pooler.supabase.com`, which is correct for STAGING and WRONG for PRODUCTION.**

- `.env.staging.rls.local` already holds a pooler-form URI on **`aws-0`** — the script passes it
  through untouched and it works.
- `.env.production.rls.local` holds the **direct** `postgresql://postgres:…@db.ozucdzovmcqvepbozvqf.supabase.co:5432/postgres`
  form, so the script rewrites it to the default host — and that fails with
  `(ENOTFOUND) tenant/user postgres.ozucdzovmcqvepbozvqf not found`, whose own error text blames the
  region but does not tell you which one is right.

**How to apply to production (measured 2026-09-22, worked first try):**

```
PHOENIX_POOLER_HOST=aws-1-eu-central-1.pooler.supabase.com node scripts/apply-sql-file.mjs <file.sql> production
```

**Why:** the error reads like a credential failure and there is no second clue — the direct
`db.<ref>` host in the env file never names a region at all, so nothing on disk tells you the answer.
Both projects are `eu-central-1`; only the pooler's **generation** differs (`aws-0` vs `aws-1`).

**How to apply it:** use the env-var prefix above for production; change nothing for staging. Do not
"fix" `DEFAULT_POOLER_HOST` to `aws-1` — that breaks the staging path, which is the one the script
is used for most. See also [[verify-the-emitted-artifact-never-the-source]].
