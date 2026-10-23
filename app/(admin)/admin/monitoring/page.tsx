import { redirect } from "next/navigation";

// Monitoring was retired on 23 Oct 2026. Its "24 hour" email figures were the latest 20 rows, its
// backlog card read 0 while the queue grew, its Recruitment feed read a table that no longer
// exists, its failed sign-in counts stopped at 1,000 and every failed read showed 0 or 100%. The
// sign-in half lives on in the System Audit's login-security section; the route stays as a forward.
export const dynamic = "force-dynamic";

export default async function AdminMonitoringPage() {
  redirect("/admin/system-audit");
}
