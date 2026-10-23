import { redirect } from "next/navigation";

import { DoubleVisitDataIntegrityWorkspace } from "@/components/double-visit-analytics/double-visit-data-integrity-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { getDoubleVisitDataIntegrityReport } from "@/lib/double-visit-analytics/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DoubleVisitDataIntegrityPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  // Company-wide and unscoped by design (a data-quality audit, not a personal/team view) — gated
  // to the admin CRM workspace (Super Admin + SFE Manager), the same door the service checks.
  if (!canUseAdminCrmWorkspace(access)) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const report = await getDoubleVisitDataIntegrityReport(access);

  return <DoubleVisitDataIntegrityWorkspace report={report} />;
}
