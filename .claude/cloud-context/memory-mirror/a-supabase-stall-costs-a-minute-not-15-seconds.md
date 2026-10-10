---
name: a-supabase-stall-costs-a-minute-not-15-seconds
description: "A stalled Supabase read cost ~67s, not 15s — `fetchWithTimeout` rethrew the abort as a plain Error, so postgrest-js's own `name === \"AbortError\"` guard missed and its network-error path bought 3 more attempts at the full budget; and a Cloudflare 521/525 was retried by nobody, because our only retry sat behind a `content-type: application/json` check and the SDK's list is `[520, 503]`."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
  modified: 2026-10-10T08:55:57.713Z
---

Found 2026-10-10 investigating his "the system is very slow with colleagues and بيعلق و تقيل".

🔴 **READ THE RETRY THAT IS ALREADY THERE BEFORE ADDING ONE.** `@supabase/postgrest-js` wraps every
request in its own `executeWithRetry`: idempotent methods only (`GET`/`HEAD`/`OPTIONS`),
`DEFAULT_MAX_RETRIES = 3`, backoff `1s/2s/4s` (`getRetryDelay`), and
**`RETRYABLE_STATUS_CODES = [520, 503]`** — nothing else. `.retry(false)` on any builder switches it
off, which is also the only clean way to unit-test our own wrapper's attempt count in isolation.

**The 15-second budget was never the hang.** `supabaseRequestTimeoutMs = 15000` is enforced per
attempt in `src/lib/supabase/server.ts`, and `fetchWithTimeout` used to convert the `AbortError` into
`new Error("Supabase request timed out.")`. The SDK's first guard is
`if (fetchError?.name === "AbortError") throw` — a deliberate refusal to retry a request that already
spent its budget — and a plain `Error` is named `"Error"`, so that guard missed and the SDK fell
through to its **network-error** path: **4 attempts × 15s + 7s backoff ≈ 67 seconds for one
`.select()`**, measured as four fetch attempts for a single read. The message must stay (`isSupabaseTimeout`
in `src/lib/reports/vacancies.ts` matches the words "timed out", and the heartbeat's 503 branch
depends on it); only the `name` needed restoring.

**A Cloudflare page is `text/html`, and that is how it escaped every retry.** Our wrapper's only
retry looked for a `PGRST002` body behind `contentType.includes("application/json")`, which an edge
error page can never satisfy, so it `break`s and the page reaches the caller as a hard failure. 521
and 525 are also absent from the SDK's `[520, 503]`, so nothing anywhere retried the statuses
production actually served. 🔴 **Do not add 520 or 503 to our set** — our wrapper sits INSIDE the
SDK's loop, so a status covered twice is 3 attempts here then 3 again outside, each re-entering the
wrapper: 16 attempts for one read.

**Where the time was NOT.** `railway metrics -s phoenix-people-workforce -e production --since 7d`:
CPU max **0.23 of 24 vCPU (1%)**, memory max **5.85 GB of 24 GB**. Database: **3 active** connections
of 200, 0 lock waits, worst statement 1.1s mean. Neither end was busy — a slow Phoenix is not
evidence of a busy container or a busy database, and `railway metrics --http` is the fastest way to
show it (last 6h, 46.6K requests: p50 354ms, p90 3,934ms, **p99 14,768ms**, the tail sitting exactly
on the 15,000ms budget). 🔴 `--http` over a window wider than ~6h fails with
`stepSeconds must be at least N`; its `--path` filter returned nothing here, so do not plan on
per-route latency from it.

**Sizing an incident from `app_error_events`: match the LITERAL phrase, not the number.** A
`message ~ '5(20|21|22|25)'` sweep reported Cloudflare 521s on 10-05 and 10-06 that did not exist —
"521" matches inside hashes and ids. `ilike '%Web server is down%'` / `'%SSL handshake failed%'` is
the honest test, and it reduced six days of apparent outage to two: **10-07** (15 × 521, 6 × 520,
across nine unrelated routes) and **10-10** 11:03–11:17 Cairo. The 15s aborts are 0 for the twelve
days to 10-06, then 27 on 10-07, 5 on 10-08, 1 on 10-09, 2 on 10-10.

**Several unrelated routes timing out in one hour is the signature of a stall above the database**,
not of a slow query — on 10-07 15:05 the heartbeat, sales-vs-target, spotlight, weekly dashboard,
territory-drilldown, organogram and sales/upload all failed together.

Fixed in PR 5737. The logout amplification is the separate [[a-supabase-blip-signs-everyone-out]]
(PR 5736, shipped 11:53 Cairo). Related: [[census-client-errors-by-stack-not-message]]
