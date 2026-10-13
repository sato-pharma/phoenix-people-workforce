---
name: a-supabase-blip-signs-everyone-out
description: "A brief Supabase outage used to sign out every working person, because the employee lifecycle gate's fail-closed `employee_lookup_failed` was indistinguishable from a resigned employee — null session, heartbeat 401, cookies cleared, and the client signs out on 401 alone."
metadata:
  node_type: memory
  type: project
  originSessionId: c2459188-d8cb-4f56-9232-71f4bd841139
  modified: 2026-10-13T01:40:00.469Z
---

Reported 2026-10-10 as "the system is failing with some colleagues like mostafa galal". It was not
about those people at all — it was a platform-wide forced logout, and the named colleague was simply
one of whoever happened to be working during the window.

**The chain.** The hosted Supabase endpoint answered Cloudflare **521 Web server is down** and **525
SSL handshake failed** between **11:03 and 11:17 Cairo**. 🔴 **Those codes were the SYMPTOM, not the
cause — the production Postgres CRASH-RESTARTED at 11:05:48 Cairo** ("database system was not
properly shut down; automatic recovery in progress"), which is why the edge had no origin to reach;
read [[a-production-postgres-crash-restart-wears-cloudflare-codes]] before attributing this class to
Cloudflare again. Then:

1. `resolveEmployeeLifecycleGate` (src/lib/auth/server.ts) fails closed on any query error or thrown
   exception → `{ allowed: false, reason: "employee_lookup_failed" }`.
2. That carried the **same `allowed: false` a resigned employee gets**, so `resolveSessionState`
   returned `null`.
3. `/api/auth/heartbeat` read `null` as "session expired", **cleared all three auth cookies** and
   answered **401**.
4. `src/components/auth/session-security-guard.tsx` signs out on a **401 alone**.
5. The heartbeat repeats about once a minute, so signing back in only bought the next minute.

"I could not reach the database" was being answered as "this person has left the company".

**How to recognise it again.** Successful logins repeating 60s apart from one IP is the signature —
Mostafa Galal (B-59) signed in 3 times in 3 minutes, PD-0019 managed 8 in 3. Sessions in
`app_sessions` with `last_seen_at = created_at` (born dead, 9 of them) mean the login POST succeeded
but the portal never rendered. `revoked_reason` stays **null** on all of them, because clearing a
cookie is not a revocation — so that column disproves nothing.

🔴 **The audit trail UNDER-REPORTS this, and by the same cause.** Only 2 `employee_lookup_failed`
rows were recorded, because `audit_persistence_failed` fired **21 times in 25 minutes** — the audit
writes were failing in the very outage they were trying to record. Never size this incident class
from `audit_logs` alone; `app_error_events` (59 in the 11:00 hour against a ~4/hour baseline) and the
login-attempt spacing are the honest signals. It had also fired on 10-07 (4 people) and 10-08 (1).

**Why the health endpoint was useless.** `/api/healthz` answered 200 in 0.29s throughout — it does
not touch the session path. The Cloudflare error code is only visible inside the `message`/`stack`
of `app_error_events`, as an HTML page whose `<title>` names it.

**The fix** (PR 5736, `codex/session-unavailable-logout`): `sessionGateOutcome()` in
`src/lib/auth/session-lifecycle.ts` maps the gate to `allow` / `reject` / `unavailable`;
`resolveSessionState` raises `SessionVerificationUnavailableError` rather than returning null; the
heartbeat answers **503** with the cookies untouched. A verified departure still ends the session.
Keeping the session through an outage grants no extra reach — every read goes through the same
database — and exposure is bounded by one heartbeat interval.

`validateAppSession` and `refreshAppSessionIdle` already `throw` on a query error, so the lifecycle
gate was the **only** place a database failure became a session rejection. `isSupabaseTimeout` only
matches the literal words "timed out", which a Cloudflare 521/525 page does not contain — that is
why the route's existing 503 path never caught this.

Related: [[census-client-errors-by-stack-not-message]] · [[a-200-from-a-health-endpoint-can-be-blind]]
