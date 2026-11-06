import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DailyDeductionsWorkspace } from "@/components/admin/daily-deductions-workspace";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso, resolveDefaultRange } from "@/lib/daily-deductions/range.ts";

export const dynamic = "force-dynamic";

// WHO MAY OPEN THIS PAGE — a role by NAME or not at all, never canAccess(deductions:read), which
// would also hand back the month Deductions screen the Finance Manager stays revoked from. Only the
// Super Admin may compute and release; CEO, HR Operations and the Finance Manager READ (owner,
// 2026-11-07, asked whether the Finance Manager should see this page: "Open the page read-only").
// Read-only is enforced on the server — /compute asserts deductions:create plus Super Admin, and
// /release, /withdraw, /supersede and POST /publish assert deductions:approve plus Super Admin.
const VIEW_ROLES = new Set(["Super Admin", "CEO", "HR Operations", "Finance Manager"]);

export default async function AdminDailyDeductionsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/daily-deductions");
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  // The default window is the open Head Office pay cycle: from its 22nd through
  // today (Cairo). The picker can widen or narrow it.
  const today = cairoTodayIso();
  const { from, to } = resolveDefaultRange(today);

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Deductions"
        title="Daily Deductions"
        subtitle="Count deductions day by day over any date range, then release them one at a time, per employee, or together — for the payroll sheet you finalize before month-end. Reuses the Fingerprint, CRM, Vacation, No-records and Weekly-plan detection of the month-final module, counting only days that have fully elapsed. Each released employee is emailed the amount, the reason and the days. Releasing here feeds no salary run; payroll takes its figures from the Deductions screen."
      />
      <DailyDeductionsWorkspace canPublish={access.role === "Super Admin"} defaultFrom={from} defaultTo={to} />
    </div>
  );
}
