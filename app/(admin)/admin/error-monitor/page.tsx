import { redirect } from "next/navigation";

// The Error Monitor is retired: it was a strict subset of System Issues, which shows the
// same self-hosted app_error_events (via the still-live getErrorEvents service) plus GCP
// Cloud Logging, live Service Health, per-user attempt counts, and the security lens.
// Permanently redirect so any bookmarks/links land on the superset dashboard.
export const dynamic = "force-dynamic";

export default function ErrorMonitorPage() {
  redirect("/admin/system-issues");
}
