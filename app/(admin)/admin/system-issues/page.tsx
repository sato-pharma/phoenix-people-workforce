import { redirect } from "next/navigation";

// System Issues was retired on 23 Oct 2026. Its "Active / Resolved" status followed deploys rather
// than fixes, its module labels read Other/Api/AI, and four of its reads stopped at 1,000 rows
// without saying so. The System Audit replaces it. The route stays so bookmarks and the alert
// buttons already sitting in people's Telegram land on the new page.
export const dynamic = "force-dynamic";

export default async function SystemIssuesPage() {
  redirect("/admin/system-audit");
}
