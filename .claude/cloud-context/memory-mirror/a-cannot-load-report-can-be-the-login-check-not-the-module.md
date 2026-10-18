---
name: a-cannot-load-report-can-be-the-login-check-not-the-module
description: "When a seat says a module \"cannot load data\" and the module reads fine afterwards, look for the login check failing at that minute (Session verification is temporarily unavailable) and the database restart log first; the module is usually innocent. Also, the restart alert records before it alerts, so a restart noticed seconds after boot can go unannounced (17 Oct 2026)."
metadata:
  node_type: memory
  type: project
  originSessionId: 63a0cb0f-4721-4bb3-9d9f-4b74c8a15af9
  modified: 2026-10-18T11:38:39.291Z
---

On 18 Oct 2026 the Talent Acquisition seat (Yomna Gamal, `HR Resourcing`) reported that recruitment data could not load. Run afterwards as her seat, all seven reads of the Recruitment page passed 3 of 3 in about 3 s. The real failure was at 10:57 Cairo, four times, in the login check that runs BEFORE any page code ("Session verification is temporarily unavailable"), while production timed out from 10:30 and was hard-restarted at 11:54:34. It was the fourth hard restart in six days (12 Oct 19:04, 14 Oct 11:34, 17 Oct 12:30, 18 Oct 11:54).

**Why:** the Recruitment page blanked on any one failed read and showed "apply the migrations on staging", the login check had no fallback, and the attendance route had made 10,461 single-row calls from 10:16 to 10:33 while the database was already struggling. What killed the database is NOT proven; only Supabase's Reports can say, and a bigger instance is a money decision made on that screen, not in chat.

**How to apply:** for any "module X cannot load" report, run that seat's reads first (dev-auth headers or the page's own loaders), then read `app_error_events` at the reported minute for the login-check message, then `public.database_restarts` for a restart that day. Do not start in the module's code. See `docs/observability.md`, "18 October 2026".

**The alert gap found the same day:** `runDatabaseRestartCheck()` recorded the 17 Oct 12:30:10 restart six seconds after boot, but the audit log has no `observability.database_restarted` row for it (14 Oct and 18 Oct have one). The record is written before the alert, so a first failed alert is never retried. The repair (re-attempt a recorded restart with no audit row that is under an hour old) was left for its own change.

Related: [[a-production-postgres-crash-restart-wears-cloudflare-codes]] · [[a-supabase-blip-signs-everyone-out]]
