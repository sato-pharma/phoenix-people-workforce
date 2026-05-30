import { redirect } from "next/navigation";

import { DeductionsGovernanceWorkspace } from "@/components/deductions-governance/deductions-governance-workspace";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getDeductionInboxKpis,
  groupByEmployee,
  groupBySource,
  listDeductionCandidates,
  listDisputes,
  listFinalApprovedDecisions,
  listRecentAuditEvents,
} from "@/lib/deductions-governance/service";

export const dynamic = "force-dynamic";

export default async function AdminDeductionsGovernancePage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "deductions", "read"))) {
    redirect("/employee-portals");
  }

  // Phase C is read-only. Decision editing is deferred to Phase C2.
  const canEditDecisions = false;

  // Server-side initial load. Failures are surfaced as empty initial state;
  // the workspace also exposes a Refresh control that re-queries the API.
  const filters = {} as const;
  let initialError: string | null = null;
  let initialKpis = null;
  let initialInbox = null;
  let initialBySource = null;
  let initialByEmployee = null;
  let initialFinalApproved = null;
  let initialDisputes = null;
  let initialAudit = null;

  try {
    const [
      kpis,
      inbox,
      bySource,
      byEmployee,
      finalApproved,
      disputes,
      audit,
    ] = await Promise.all([
      getDeductionInboxKpis({ access, filters }),
      listDeductionCandidates({ access, filters, page: 1, pageSize: 50 }),
      groupBySource({ access, filters }),
      groupByEmployee({ access, filters, limit: 100 }),
      listFinalApprovedDecisions({ access, filters }),
      listDisputes({ access, filters }),
      listRecentAuditEvents({ access, limit: 50 }),
    ]);
    initialKpis = kpis;
    initialInbox = inbox;
    initialBySource = bySource;
    initialByEmployee = byEmployee;
    initialFinalApproved = finalApproved;
    initialDisputes = disputes;
    initialAudit = audit;
  } catch (error) {
    initialError = error instanceof Error
      ? error.message
      : "Deductions Governance Center failed to load.";
  }

  return (
    <AppShell navigationMode="admin">
      <DeductionsGovernanceWorkspace
        canEditDecisions={canEditDecisions}
        initialAudit={initialAudit}
        initialByEmployee={initialByEmployee}
        initialBySource={initialBySource}
        initialDisputes={initialDisputes}
        initialError={initialError}
        initialFinalApproved={initialFinalApproved}
        initialInbox={initialInbox}
        initialKpis={initialKpis}
      />
    </AppShell>
  );
}
