import { redirect } from "next/navigation";

import { DailyDeductionsPortalSection } from "@/components/employee-portal/daily-deductions-section";
import { DeductionsPortalWorkspace } from "@/components/employee-portal/deductions-workspace";
import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  assertPermission,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key";
import { getPortalDeductionLedger } from "@/lib/deductions/portal.ts";
import { getPortalDailyDeductions } from "@/lib/daily-deductions/portal.ts";
import { listOwnDailyLineDisputes } from "@/lib/dispute-center/daily.ts";
import type { DailyDeductionsPortalLine } from "@/lib/daily-deductions/types";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

// The sidebar's own words: "Deductions" under "Pay & Expenses". The unavailable state keeps the same
// header, so the page never loses its title when the data does not load.
//
// The description changed with the page on 2026-10-09: it is no longer only the finalized ones. It
// now lists EVERY deduction raised against the person from the September salary on, with HR's answer
// on each, and the three filters are in the workspace itself — so this page takes no searchParams.
const PAGE_BADGE = "Pay & Expenses";
const PAGE_TITLE = "Deductions";
const PAGE_DESCRIPTION = "Every deduction raised against you, and what HR decided on each one.";

export default async function DeductionsPortalPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/admin/deductions");
  }

  await assertPermission(access, "employee_profile", "read");

  // The released DAILY lines are read beside the ledger and fail on their own: a failed daily read
  // says so in its own section, and never takes the month ledger down with it (owner, 2026-11-07:
  // "Show daily lines", so the release email's "Open your Deductions page" shows what it promised).
  const dailyRead = getPortalDailyDeductions({ access }).then(
    (result) => ({ lines: result.lines, unavailable: false }),
    (error: unknown) => {
      logPortalFailure(
        { route: "/employee-portals/deductions", module: "daily-deductions", role: access.role, hrId: access.hrId },
        error,
      );
      return { lines: [] as DailyDeductionsPortalLine[], unavailable: true };
    },
  );

  // The dispute already raised on each released line (owner, 2026-11-13: the daily lines had no Dispute
  // button). A failed read is null, and the boxes are then left off rather than offering a second dispute.
  const disputesRead = listOwnDailyLineDisputes(access).then(
    (map) => Object.fromEntries([...map].map(([lineId, dispute]) => [lineId, { id: dispute.id, status: dispute.status }])),
    (error: unknown) => {
      logPortalFailure(
        { route: "/employee-portals/deductions", module: "daily-deduction-disputes", role: access.role, hrId: access.hrId },
        error,
      );
      return null;
    },
  );

  let data: Awaited<ReturnType<typeof getPortalDeductionLedger>>;
  try {
    data = await getPortalDeductionLedger({ access });
  } catch (error) {
    // The reason goes to the server log, not the screen: what this throws is a database error, and
    // its wording means nothing to the person reading the page.
    logPortalFailure(
      { route: "/employee-portals/deductions", module: "deductions", role: access.role, hrId: access.hrId },
      error,
    );
    return (
      <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
        <EmployeePortalEmptyState
          message="We could not load your deductions right now. Please try again in a moment."
          title="Deductions Unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  const [daily, dailyDisputes] = await Promise.all([dailyRead, disputesRead]);

  return (
    <EmployeePortalPageShell badge={PAGE_BADGE} description={PAGE_DESCRIPTION} title={PAGE_TITLE}>
      <div className="space-y-4">
        <DailyDeductionsPortalSection disputes={dailyDisputes} lines={daily.lines} unavailable={daily.unavailable} />
        <DeductionsPortalWorkspace
          comments={data.comments}
          firstMonthKey={data.firstMonthKey}
          ownCompactHrId={compactDeductionsHrId(access.hrId ?? access.loginId)}
          rows={data.rows}
        />
      </div>
    </EmployeePortalPageShell>
  );
}
