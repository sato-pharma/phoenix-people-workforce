---
name: check-migrations-applied-exits-zero-when-it-cannot-reach-supabase
description: "A hand-run `node scripts/check-migrations-applied.ts` with no env file prints `FAILED: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set` and still EXITS 0, so a session reading the exit code calls the ledger clean when nothing was measured — pass `--env-file=.env.local`; CI is unaffected because migration-drift-check.yml supplies both variables inline."
metadata:
  node_type: memory
  type: project
  originSessionId: c556d75c-2b85-462d-84be-feb9bbb9e05f
  modified: 2026-10-08T19:56:59.352Z
---

Measured 2026-10-08. Run by hand from the repo root with no env file, the migration drift check says:

```
[migration-drift-check] FAILED: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set
                                — cannot reach the target Supabase project.
[exited with code 0]
```

🔴 **The word is FAILED and the exit code is 0.** A background task's completion notification
reports only the exit status, so that run arrives as "completed (exit code 0)" — indistinguishable
from a clean ledger. Nothing was measured at all.

**The fix is the env file:** `node --env-file=.env.local --experimental-strip-types
--experimental-specifier-resolution=node scripts/check-migrations-applied.ts`. `.env.local` points
at PRODUCTION Supabase, which is the leg worth checking; the script's only call is the read-only
`phx_ci_migration_versions` RPC.

🔴 **This is a HAND-RUN trap, not a CI hole — do not "fix" the workflow.**
`.github/workflows/migration-drift-check.yml` passes `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` inline to both legs, and the production leg is additionally gated on
`HAS_PRODUCTION_SUPABASE_KEY == 'true'`, so a missing key SKIPS that step rather than running it
blind. The `continue-on-error` on those steps is deliberate (a finding must not withhold a deploy)
and the four setup steps above them deliberately still fail the job — the distinction the whole
workflow rests on is FINDING versus BROKEN. Read the comments in that file before touching it.

Run properly on 2026-10-08 it reported **804 local migrations against 1,265 recorded on
`ozucdzovmcqvepbozvqf`** and exactly one file past the 48-hour grace window, which is the real
signal this check exists to give. Related: [[a-ledger-version-never-matches-the-file]] explains why
the counts never line up, and [[the-ledger-can-miss-a-version-whose-objects-are-live]] why a present
object is not proof.
