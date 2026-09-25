---
name: healthchecks-schedules-are-synced-from-the-doc-table
description: "Every Healthchecks check is born on Healthchecks' DEFAULTS (1-day period, 1-hour grace) and nothing corrects it — `pnpm run healthchecks:sync` fixes all 14 from the docs/observability.md table, but needs a PROJECT API key that is NOT the ping key"
metadata:
  node_type: memory
  type: project
  originSessionId: 95a9153c-7cad-40ba-8918-05de11f9c69f
---

**A Healthchecks check auto-provisions on its first successful ping with Healthchecks' own defaults
— a 1-day period and a 1-hour grace — and NOTHING ever corrects that.** So a job that really runs at
02:17 Cairo, or weekly, or every five minutes, sits permanently red against a schedule nobody chose.
**9 of the 14 were in exactly that state on 2026-08-23** — the first live sync updated 8 and created
1; 5 had been tuned by hand at some point. Two of the 8 still carried **dead GCP-era schedules**
(`7 9,12,19 * * *` for the iReports sync, `24 4 * * 0` for the reconcile) and were going red daily
against jobs that ran fine. See
[[a-cron-that-fails-nightly-can-do-so-forever-unwatched]] for why an always-red dashboard is the
same failure as no dashboard at all.

**`pnpm run healthchecks:sync`** (`scripts/healthchecks-sync.mjs`, PR #2331, merged 2026-08-23 as `3e7af49c`) does it instead: it
reads the table in `docs/observability.md` as the source of truth and makes Healthchecks match —
cron expression, timezone, grace. Dry-run unless `--apply`. It reads the checks back after writing
rather than trusting the POST.

🔴 **THE KEY IS THE BLOCKER, AND IT IS A DIFFERENT CREDENTIAL FROM THE ONE THAT EXISTS.**

| | What it does | Present here? |
| --- | --- | --- |
| `HEALTHCHECKS_PING_KEY` | pings, and **creates** a check via `?create=1` | **yes** (Railway + `.env.local`, len 22) |
| `HEALTHCHECKS_API_KEY` | the management API — **the only way to set schedule/tz/grace** | **NO** — must be made in Settings › API keys |

A ping key **can create a check but cannot configure it.** That single fact is the whole reason
fourteen checks sat on defaults for months. Verified 2026-08-23 by listing *every* env var name on
Railway production and in `.env.local` — do not go hunting again, it is not there. The script's 401
handler says this in words. Owner-only to add (it is a credential); it can be passed inline for one
run instead of stored: `HEALTHCHECKS_API_KEY=… pnpm run healthchecks:sync --apply`.

**Timezone is not cosmetic.** Healthchecks defaults to **UTC**; cron-job.org fires these in
**Africa/Cairo** ([[cron-job-org-is-managed-by-a-rest-api-not-just-the-web-ui]]). A UTC check has its
expected-ping window 2–3 h off the real one and shifts again at every Egyptian DST change — red
against a job running perfectly.

**The doc table is machine-read, and its format has already changed once** (it grew a fourth column
and a `**Simple**`-period row among the cron ones). `tests/healthchecks-schedule-sync.test.ts` fails
CI if it stops parsing, if a row loses `Africa/Cairo`, or if either Direct Orders row drifts from its
live cron-job.org clock — because a parser that silently matches nothing turns the sync into a no-op
that reports success, which is the same silent failure rebuilt inside the cure.

🔴 **A check created through the MANAGEMENT API is stored with an EMPTY slug unless `slug` is sent
explicitly — and the app pings by SLUG, never by name** (`hc-ping.com/<ping-key>/<slug>?create=1`).
A slugless check never receives the ping it waits for: it goes red on schedule while the job runs
perfectly, and the next real ping auto-provisions a **second** check beside it on the defaults. Hit
on the very first live run (`STILL WRONG after write: phoenix-direct-orders-probation`) and caught
only by the script's own read-back. Fixed in PR #2341 — the API does accept `slug` on POST.

**Two checks in the project are NOT in the doc table and the sync ignores them:** `My First Check`
(Healthchecks' own sample, never pinged) and `phoenix-ireports360-live-sync` (**down** — its only
caller, cron-job.org job `8200918`, has been disabled since 2026-08-16; the doc says to delete it).
Deleting either needs the owner's go.

**How to apply:** never tune a check by hand in the dashboard — edit the table row, then run the
script. And if a check is red, check its *schedule* before assuming the job is dead.
