---
name: prod-min-instances-dropped-to-zero-2026-07-16
description: "SUPERSEDED (Vercel/Cloud Run/GCP era) — phoenix-hr prod's --min-instances was dropped from 1 to 0 for cost savings (2026-07-16), reintroducing the cold-start risk the setting was originally added to eliminate."
metadata: 
  node_type: memory
  type: project
  originSessionId: c8f93249-c87d-4184-8127-174d9b62301d
---

> **SUPERSEDED 2026-08-19 — history only, do NOT act on anything below.** This file describes the
> Vercel / GCP Cloud Run / Sentry / npm era. Since 2026-08-01 production is **Railway** (service
> `phoenix-people-workforce`, region `europe-west4`): a merge to `main` ships to production
> immediately, there is no deploy cron and no `gcloud` path, GCP billing is closed (every API
> returns `BILLING_DISABLED`), and the live scheduler is the third-party cron-job.org. Current
> truth: `AGENTS.md` §2/§3 and the Railway lines in `MEMORY.md`.

**What happened:** on 2026-07-16, a concurrent session (title "google cloud health", worktree `strange-northcutt-768bd0`, branch `claude/agitated-ptolemy-325ce0`) finished IAM least-privilege hardening on the Cloud Run build service account, then did cost analysis: Phoenix Workforce's GCP spend (~$70-100/mo) is almost entirely (~$68/mo) `phoenix-hr` prod's always-on instance (`--min-instances 1`). It asked the user (via an in-session question) to choose cost vs. cold-start latency; the user chose "near-free." The session applied `min-instances=0` directly to production via local `gcloud` (creator `phoenixx.oag@gmail.com`, not the GitHub Actions WIF identity — bypasses the deploy pipeline same as the untagged manual deploy in [[notifications-process-cron-504-timeout-fix]]) at **2026-07-16T19:03:35Z**, producing revision `phoenix-hr-00104-v96`.

**Why this matters — the setting was added specifically to fix this:** [[gcp-cloud-run-migration-2026-07]] (line 28, 2026-07-11) already notes "`--min-instances=1` to kill the ~16–25s landing cold-start" as the reason it was set in the first place, and `docs/gcloud-production-migration-audit.md` documents the same ~15-25s cold-start estimate at minScale 0. Dropping back to 0 reintroduces that exact tradeoff.

**Concrete risk found and confirmed live:** the uptime check (`phoenix-hr-healthz`, checks `/api/healthz`) has **period=300s, timeout=10s**. A cold start (15-25s) exceeds that 10s timeout, so a cold-start-hit probe registers as a check failure. Confirmed directly in Cloud Logging immediately after the change: two `/api/healthz` requests from `GoogleStackdriverMonitoring-UptimeChecks` took **23.7s** and **19.99s** (both way over the 10s timeout) at 19:04:32Z/19:04:36Z, right after the instance went cold for the first time. The alert policy "phoenix-hr uptime check failing" (`healthz uptime < 50%`, sustained 300s) did **not** fire from this single blip — a one-off dip doesn't satisfy its sustained-duration requirement — but a longer/repeated cold-start pattern could.

**Follow-up (2026-07-16, same session):** watched Cloud Logging for 30 consecutive clean minutes (19:13-19:43Z) after the change — zero further slow probes, zero fired alerts. Confirms no immediate/ongoing instability while the app had residual traffic keeping it warm. **Does NOT rule out** a cold start (and possible alert firing) after a longer idle gap later, e.g. overnight when traffic actually drops enough for the instance to scale to zero for an extended period — the 30-minute window couldn't observe that scenario either way.

**Follow-up PR shipped:** [PR #1071](https://github.com/Phoenix-HR/phoenix-people-workforce/pull/1071) (`ci(deploy): set prod Cloud Run min-instances to 0 (near-free)`, merged 2026-07-16T19:50:45Z) — one-line change in `.github/workflows/deploy-cloud-run.yml` (`--min-instances 1` → `0`, prod step only; staging was already 0). No conflict with [[cloud-run-stale-tag-cpu-quota-exhaustion]]'s PR #1066, which only appended a cleanup step to the same file. This locks the live change in so future pipeline deploys no longer revert it.

**Risk reassessed downward (per #1071's own rationale, worth noting):** the `*/5` notification-processing cron (`/api/notifications/process`) hits the service every 5 minutes regardless of auth outcome — the container still has to boot to reject an unauthorized request — so in steady state this acts as incidental keep-warm traffic. Real full-idle cold starts should mostly be confined to the brief window right after a deploy, not arbitrary overnight gaps as originally worried. Still worth keeping an eye on the "phoenix-hr uptime check failing" alert given the confirmed 10s-timeout-vs-15-25s-cold-start mismatch documented above.

**How to apply:** if the "phoenix-hr uptime check failing" alert fires, or users report an occasional slow first-load, check first whether it's a genuine outage or just this cold-start/10s-timeout mismatch (cross-check Cloud Run request logs for `/api/healthz` with `userAgent:"StackdriverMonitoring"` and look for latency > 10s around the alert time). If cold starts become a real recurring problem, the fix is either (a) raise the uptime check's timeout above the observed cold-start duration, or (b) revert to `--min-instances 1` (reintroducing the ~$68/mo cost) — don't just silently patch one side without understanding which the owner prefers, since this was an explicit cost-vs-latency tradeoff decision.
