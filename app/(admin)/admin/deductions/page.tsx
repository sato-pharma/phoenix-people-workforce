import { redirect } from "next/navigation";

import { PremiumHero } from "@/components/ui/premium-hero";
import { DeductionsWorkspace } from "@/components/admin/deductions-workspace";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";

export const dynamic = "force-dynamic";

// WHO MAY OPEN THIS PAGE. A role set, deliberately — NOT canAccess(access, "deductions", "read").
//
// Owner, 2026-08-11: revoked for the Finance Manager at the PAGE, not just the sidebar. These
// three had been hidden from his navigation only, which a live role sweep showed still rendered
// them on a typed or bookmarked URL — hidden is not revoked. He keeps Monthly Closing and the
// Marketing Inbox; what goes is sales-management reporting and the legacy Excel ROI set.
// Removing him from this set IS the revocation — the page already redirects anyone outside it.
//
// So this set is NARROWER than the matrix on purpose, and swapping it for a permission check would
// silently hand the page back to the Finance Manager, who still holds deductions:[read, export]
// because payroll surfaces he keeps are built on it. Add a role by NAME or not at all.
//
// HR Operations added 2026-09-03, the owner's answer in his own words: "yes give HR access to the
// deductions screen." Asked because the employee-comment thread now mails HR (src/lib/deductions/
// comments.ts) and the link in that mail landed her on /employee-portals. Her seat has held
// deductions:read since it was composed — payroll_inputs, cited to "ops 3 — Payroll HR Inputs &
// Monthly Closure", whose JD line is "ensure no deduction is processed without evidence and
// approval" — so this opens a page her grant already covered rather than widening the matrix.
//
// It stays READ-ONLY, and by three independent mechanisms rather than by this line's good manners:
// canDecide below is Super Admin alone, so no control renders; every mutating route asserts a
// stricter action than it (POST publish and decisions assert deductions:approve, collect, manual
// and settlement assert deductions:create) and she holds neither; and HR_ROLE_BOUNDARIES pins
// deductions:approve/create/update ABSENT from both HR seats, asserted in
// tests/hr-function-governance.test.ts. Publishing a deduction month stays the owner's, per his
// standing rule that the system flags an expense and never decides one.
//
// HR Advisory is NOT here. Payroll appears nowhere in the HR Business Partner job description and
// she is excluded by name from every other payroll surface (Payroll Management, Payslips Center
// company-wide) for that reason. She still receives the comment itself — the mail carries the
// message in full — and the owner was told the link bounces for her.
const VIEW_ROLES = new Set(["Super Admin", "CEO", "HR Operations"]);

export default async function AdminDeductionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/deductions");
  if (!VIEW_ROLES.has(access.role)) {
    redirect("/employee-portals");
  }

  // Deep link from a deduction-comment notification: ?tab=disputes&candidate=<id>. The workspace
  // opens on that tab and scrolls the named thread into view. A single-value read only — a repeated
  // query param arrives as an array, which is not a tab or a candidate id.
  const params = await searchParams;
  const tabParam = typeof params.tab === "string" ? params.tab : undefined;
  const candidateParam = typeof params.candidate === "string" ? params.candidate.trim() || undefined : undefined;

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
        highlightCandidateId={candidateParam}
        initialMonthKey={initialMonthKey}
        initialTab={tabParam === "disputes" ? "disputes" : undefined}
      />
    </div>
  );
}
