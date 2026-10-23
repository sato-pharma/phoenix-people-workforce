---
name: load-failed-is-the-reps-network-not-a-crm-fault
description: "Load failed" / "network error" in app_error_events is the browser's wording for a fetch the rep's own connection cut off — chronic on every portal page since 5 Aug, never a deploy regression; read it per DEVICE and per PAGE before calling Phoenix CRM broken.
metadata:
  type: project
---

`Load failed` (Safari/iOS, 926 rows), `network error` (Chrome/Android, 276) and `Failed to fetch`
(7) in `public.app_error_events` are one thing: a fetch that died in flight because the connection
went. Measured 23 Oct 2026 over 5 Aug–22 Oct: **62 different releases, all three platforms, ~40 a
day, nothing on the day of the read** — so it correlates with no deploy and no page.

**Why:** the stack on every row is `— Client context —` only, with **no `context=` marker**, which by
`report-client-error.ts`'s own contract means no caller caught it: it arrived at
`GlobalErrorReporter`'s `unhandledrejection` net, as a fetch `TypeError` whose frames the browser
strips. Rows arrive in bursts (`seq=4`, `seq=5` 0.3 s apart) with `readyState=complete
visibility=visible unloading=false sinceNavMs≈177000 net=4g downlinkMbps=2` — several in-flight
requests dying together, i.e. the network, not an endpoint. Phoenix's own fetches are already
guarded (`session-security-guard`, `activity-tracker`, `touch-trail-collector`, `notices-seen`,
`onesignal-provider`, and `phoenix-crm/api.ts`, which converts a dropped fetch into "No connection.
Check the phone's internet and try again."); what is left uncaught is the App Router's own
RSC navigation/prefetch request, which the app does not own.

**Why it reads as a Phoenix CRM fault:** the route column follows the rep, so CRM tops the list
(`field-crm/visits` 441, `field-crm/list` 276, `field-crm` 121) only because that is where reps
spend the day on a phone. The same rows land on `/employee-portals` (170), Monthly Closing, Profile,
KPIs, Deductions and Organogram.

**How to apply:** group by device and page before answering — reading `Load failed` alone makes it
look iOS-only and CRM-only, which is [[census-client-errors-by-stack-not-message]] again. The only
real gap is that nothing retries: the rep sees the offline sentence or a tap that does not advance.
`browser-noise.ts` deliberately keeps these out of Sentry only; the table records every one.
