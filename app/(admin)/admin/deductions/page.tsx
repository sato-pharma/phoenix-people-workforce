import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DeductionsWorkspace } from "@/components/admin/deductions-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

  // Owner, 2026-08-11: revoked for the Finance Manager at the PAGE, not just the sidebar. These
  // three had been hidden from his navigation only, which a live role sweep showed still rendered
  // them on a typed or bookmarked URL — hidden is not revoked. He keeps Monthly Closing and the
  // Marketing Inbox; what goes is sales-management reporting and the legacy Excel ROI set.
// Removing him from this set IS the revocation — the page already redirects anyone outside it.
const VIEW_ROLES = new Set(["Super Admin", "CEO"]);

export default async function AdminDeductionsPage() {
  const access = await resolveAccessContextFromPage();
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  // Cairo, not UTC: this key seeds the workspace's state and is what the publish action files
  // deductions under. In the first 2-3 hours of a Cairo month a UTC key still reads the previous
  // month, which would land real deductions on the wrong payslip month.
  const { year, month } = currentCairoDateParts();
  const initialMonthKey = `${year}-${String(month).padStart(2, "0")}`;

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Deductions"
        title="Deductions"
        subtitle="Single source of truth for every payroll deduction — Fingerprint, CRM, No Records Activity, Unpaid Vacation, Insufficient Balance Vacation, Loan, and Other. Compute, decide, and (once published) feed Automated Payroll and the employee portal."
      />
      {/* Both props hold the current Cairo month, but they mean different things and must not be
          collapsed into one. `initialMonthKey` is what the workspace SELECTS and what publish files
          deductions under — seeding it to the current month is deliberate. `currentCairoMonthKey` is
          the boundary the collection control compares against to decide whether the month has
          finished, which is what stops it firing six requests the server will refuse. */}
      <DeductionsWorkspace
        canDecide={access.role === "Super Admin"}
        currentCairoMonthKey={initialMonthKey}
        initialMonthKey={initialMonthKey}
      />
    </div>
  );
}
