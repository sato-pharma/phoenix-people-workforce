---
name: cron-secret-rotation-broke-all-crons-2026-07-31
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — CRON_SECRET rotation 401'd every cron for ~14 min. RESOLVED. Cloud Run was pinned to a secret version that got disabled — always use secretKeyRef latest."
metadata: 
  node_type: memory
  type: project
  originSessionId: 516a53ef-c89e-4a6c-a03a-f0eb456de1af
  modified: 2026-07-31T21:25:31.603Z
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**RESOLVED 2026-07-31 21:12Z.** All 8 crons back to HTTP 200; all 8 Healthchecks `up`. Outage ~20:58→21:12Z (~14 min).

**What happened.** A CRON_SECRET rotation (another session, CRLF-corruption fix — see [[git-bash-crlf-corrupts-secrets-written-to-secret-manager]]) churned four Secret Manager versions in 13 minutes: v2 `20:55`, v3 `21:06`, v4 `21:08`. **v2 and v3 were then DISABLED**, v4 became the good value. Meanwhile the Cloud Run service deployed at `20:56` (`phoenix-hr-00268-2qn`) had **`secretKeyRef: {key: "2"}`** — a hard pin to a version that was subsequently disabled — while the 8 Cloud Scheduler jobs carried v4. Mismatch ⇒ `isAuthorized()` rejected every call with 401.

**The load-bearing mistake: hard-pinning the secret version.** The previously-working revision used `key: "latest"`; the 20:56 deploy pinned `"2"`. A pinned version cannot pick up a rotation *and* breaks outright once that version is disabled. **Fix applied:** `gcloud run services update phoenix-hr --region=europe-west3 --update-secrets=CRON_SECRET=CRON_SECRET:latest` → revision `phoenix-hr-00270-z9m`, 100% traffic. Verified byte-exact: v4 raw = 64 bytes, sha `c9ab1775…` == the scheduler's `Authorization: Bearer` token sha. **Always use `:latest` for CRON_SECRET on Cloud Run.**

> ⚠️ **CORRECTION (added by the session that actually caused this outage, 2026-07-31 ~21:25Z).**
> The `:latest` advice above is good hygiene and worth keeping — **but "pinned to a version that
> got disabled" is NOT what caused these 401s**, and a future session acting on that root cause
> would miss the real trap.
>
> **Timeline evidence:** v2 and v3 were disabled at ~21:15Z — *after* the crons were already
> confirmed back to HTTP 200 at 21:12–21:13Z. Throughout the entire 20:59→21:12 outage window,
> v2 was still **ENABLED**. A disabled version therefore cannot explain 401s that had already
> stopped before any version was disabled.
>
> **Actual root cause: the stored v2 value was byte-corrupt.** Measured directly with
> `gcloud secrets versions access 2 --secret=CRON_SECRET | od -c` → **67 bytes ending `\r \r \n`**
> (v3 = 65 bytes, trailing `\r`; the known-good v1 and the fixed v4 = clean). Git Bash on this
> Windows machine injects CR into `openssl rand -hex 32 | gcloud secrets versions add --data-file=-`.
> The app read `"<hex>\r\r\n"` and compared it to a scheduler header whose value had been written
> via `$(...)`, which **strips** trailing whitespace → the two could never match, regardless of
> which version was pinned or enabled. Full detail + the correct write/verify recipe:
> [[git-bash-crlf-corrupts-secrets-written-to-secret-manager]].
>
> **On the note in "Verification recipe" below** — that `tr -d '\r\n'` "produced a false mismatch"
> and led to chasing a phantom fourth secret: that comparison was actually revealing the *real*
> corruption. Stripping CR/LF from one side and not the other is exactly the diff that mattered.
> The reliable check is **`wc -c` + `od -c` on the stored value itself** (must be exactly 64 clean
> bytes), *not* a sha of two shell-substituted strings — command substitution strips the corruption
> from **both** operands identically, so the hashes match while production stays broken. That false
> green is what cost the most time here.

**Both halves must be rotated together.** The secret lives in **two** places: Secret Manager (read by Cloud Run) and the `Authorization` header of **8 Cloud Scheduler jobs in `us-central1`** (NOT europe-west3 — `jobs describe --location=europe-west3` returns NOT_FOUND even though the service is there). Rotating one side alone guarantees a 401 outage.

**Verification recipe** (hash-only, never print the secret): compare `sha256` of `gcloud secrets versions access <v>` against `sha256` of the scheduler job's Bearer token. Compare **raw bytes** — an earlier comparison that piped through `tr -d '\r\n'` produced a false mismatch and sent me chasing a phantom "fourth secret".

**Also found:** `phoenix-background-jobs` is **PAUSED** in Cloud Scheduler (weekly Friday job) — pre-existing, still open. And `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` vanished from the service env between `00739-sab` (53 keys) and `00268-2qn` (52) — unexplained, worth a look.

> **Answered:** `PRODUCTION_SUPABASE_SERVICE_ROLE_KEY` did not "vanish" — it was **deliberately
> removed** at 2026-07-31 ~20:40Z (revision `phoenix-hr-00264-zpj`) as the first step of the
> credential-rotation pass. It was a **literal env var holding a full unredacted service-role JWT**,
> and grep confirmed **no application code reads it** — it is only consumed as a *GitHub Actions*
> secret of the same name by `.github/workflows/migration-drift-check.yml:35,77`. That CI secret is
> separate and untouched. Removing the Cloud Run copy was zero-impact and took one live prod JWT out
> of every `gcloud run services describe` output. **Nothing to investigate — do not restore it.**
> Context: [[disk-hygiene-sweep-2026-07-31-94-orphans-pending-approval]].

**Why it was caught:** the Healthchecks dead-man's-switch flipped `phoenix-process-notifications` and `phoenix-inbound-intake` to DOWN within their 10-min grace. Sentry could not have — its monitors were muted hours earlier the same evening, and it never had a `background-jobs` monitor. First real day, first real catch. See [[healthchecks-live-8-checks-configured]].

Related: [[claude-config-audit-2026-07-31]] · [[parallel-session-pr-collision-1506-1508]]
