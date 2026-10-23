import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DailyDeductionsWorkspace } from "@/components/admin/daily-deductions-workspace";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { cairoTodayIso, resolveDefaultRange } from "@/lib/daily-deductions/range.ts";

export const dynamic = "force-dynamic";

// WHO MAY OPEN THIS PAGE. The same set as the month-final Deductions page — the
// two surfaces are two views of the same money — and NARROWER than the matrix on
// purpose (the Finance Manager keeps deductions:read for payroll surfaces but is
// revoked from this reporting screen; add a role by NAME or not at all). Only the
// Super Admin may compute and release; CEO and HR Operations read.
const VIEW_ROLES = new Set(["Super Admin", "CEO", "HR Operations"]);

export default async function AdminDailyDeductionsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/daily-deductions");
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  // The default window is the open pay cycle: the 21st of the previous month
  // through today (Cairo). The picker can widen or narrow it.
  const today = cairoTodayIso();
  const { from, to } = resolveDefaultRange(today);

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Deductions"
        title="Daily Deductions"
        subtitle="Count deductions day by day over any date range, then release them one at a time, per employee, or together — for the payroll sheet you finalize before month-end. Reuses the Fingerprint, CRM and Vacation detection of the month-final module, counting only days that have fully elapsed. Releasing here feeds no salary run; it is a reviewed reporting snapshot."
      />
      <DailyDeductionsWorkspace canPublish={access.role === "Super Admin"} defaultFrom={from} defaultTo={to} />
    </div>
  );
}
