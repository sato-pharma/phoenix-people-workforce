// RETIRED 2026-08-30, by the owner, in the conversation.
//
// Cron Control — the GCP Cloud Scheduler dashboard.
//
// It listed, paused, resumed, triggered and rescheduled Cloud Scheduler jobs through the GCP REST
// API. GCP billing closed on 2026-08-01 and every API in project phoenix-workforce-498619 has
// returned BILLING_DISABLED since, so listCronJobs() could only ever resolve to
// { available: false, error } — the page rendered an error box and nothing else, for anyone who
// opened it. It could not see, and could not control, the scheduler that actually runs production:
// cron-job.org (AGENTS.md 3). A dashboard that shows a dead system's jobs and hides the live one's
// is worse than no dashboard, because it answers "are the crons healthy?" with the wrong scheduler.
//
// The page was not empty, though, and that is why this is a redirect rather than a deletion. Below
// the dead dashboard it also rendered the LIVE Notification Recipients editor, which had no page of
// its own. That editor now lives at /admin/notification-recipients — the URL AGENTS.md 2.3 already
// tells an operator to use when a stranded notification drain pages a human, and which until now
// returned a 404. This stub sends the bookmark there.
//
// The job registry (src/lib/cron-control/job-registry.ts) is deliberately KEPT. It has outlived the
// dashboard as the manifest of the 9 live cron routes, and tests/cron-control-registry.test.ts uses
// it to assert every one of them is registered authMode:"cron-secret" in access-registry.ts. That
// is a live security invariant about cron auth, not a fact about GCP.
//
// DO NOT rebuild this against cron-job.org without asking first: its REST API allows 100 requests
// per DAY and a bulk edit costs ~34 and cannot be rolled back (AGENTS.md 2.3).
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CronControlPage() {
  redirect("/admin/notification-recipients");
}
