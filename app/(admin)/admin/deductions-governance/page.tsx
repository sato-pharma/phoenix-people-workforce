import { redirect } from "next/navigation";

import { DeductionsGovernanceWorkspace } from "@/components/deductions-governance/deductions-governance-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isDeductionsGovernanceDecisionActor } from "@/lib/deductions-governance/calculations";
import {
  getDeductionInboxKpis,
  groupByEmployee,
  groupBySource,
  listAvailableDeductionMonthKeys,
  listDeductionCandidates,
  listDisputes,
  listFinalApprovedDecisions,
  listRecentAuditEvents,
  listRecentDeductionComments,
} from "@/lib/deductions-governance/service";

export const dynamic = "force-dynamic";

export default async function AdminDeductionsGovernancePage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "deductions", "read"))) {
    redirect("/employee-portals");
  }

  const canEditDecisions = isDeductionsGovernanceDecisionActor(access);
  const canSync = canEditDecisions;

  // Server-side initial load. Failures are surfaced as empty initial state;
  // the workspace also exposes a Refresh control that re-queries the API.
  let initialError: string | null = null;
  let initialKpis = null;
  let initialInbox = null;
  let initialBySource = null;
  let initialByEmployee = null;
  let initialFinalApproved = null;
  let initialDisputes = null;
  let initialAudit = null;
  let initialComments = null;
  let availableMonthKeys: string[] = [];
  let defaultMonth: string | undefined;

  // Fetch selectable months first (candidates + FWC archive months + recent calendar
  // months) so the picker is never empty, then pre-select the best default and load all
  // data scoped to that month.
  try {
    const monthInfo = await listAvailableDeductionMonthKeys({ access });
    availableMonthKeys = monthInfo.months;
    defaultMonth = monthInfo.defaultMonthKey;
  } catch {
    // Non-fatal — workspace falls back to a free-text month input
  }

  const filters = defaultMonth ? { monthKey: defaultMonth } : ({} as const);

  try {
    const [
      kpis,
      inbox,
      bySource,
      byEmployee,
      finalApproved,
      disputes,
      audit,
      comments,
    ] = await Promise.all([
      getDeductionInboxKpis({ access, filters }),
      listDeductionCandidates({ access, filters, page: 1, pageSize: 50 }),
      groupBySource({ access, filters }),
      groupByEmployee({ access, filters, limit: 100 }),
      listFinalApprovedDecisions({ access, filters }),
      listDisputes({ access, filters }),
      listRecentAuditEvents({ access, monthKey: defaultMonth, limit: 50 }),
      listRecentDeductionComments({ access, limit: 100 }),
    ]);
    initialKpis = kpis;
    initialInbox = inbox;
    initialBySource = bySource;
    initialByEmployee = byEmployee;
    initialFinalApproved = finalApproved;
    initialDisputes = disputes;
    initialAudit = audit;
    initialComments = comments;
  } catch (error) {
    initialError = error instanceof Error
      ? error.message
      : "Deductions Governance Center failed to load.";
  }

  return (
    <DeductionsGovernanceWorkspace
      availableMonthKeys={availableMonthKeys}
      canEditDecisions={canEditDecisions}
      canSync={canSync}
      defaultMonthKey={defaultMonth}
      initialAudit={initialAudit}
      initialByEmployee={initialByEmployee}
      initialBySource={initialBySource}
      initialComments={initialComments}
      initialDisputes={initialDisputes}
      initialError={initialError}
      initialFinalApproved={initialFinalApproved}
      initialInbox={initialInbox}
      initialKpis={initialKpis}
    />
  );
}
