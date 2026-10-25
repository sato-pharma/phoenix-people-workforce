import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildEmployeePlansPdf, buildEmployeePlansWorkbook } from "@/lib/weekly-planning/export";
import { isDistrictManagerPlanTitle } from "@/lib/weekly-planning/plan-v1";
import { getEmployeePlansWorkspace, type EmployeePlan } from "@/lib/weekly-planning/service";
import { isSecondApproverForManager, planHasSecondApprover } from "@/lib/weekly-planning/second-approver";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { hrIdsMatch } from "@/lib/hr-id";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { DOWNLOAD_NO_STORE_HEADERS } from "@/lib/http/download-headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unable to export weekly/monthly plans.");
  return NextResponse.json(
    {
      error: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")
        ? "forbidden"
        : "weekly_plan_export_failed",
      message,
      success: false,
    },
    { status: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:") ? 403 : 400 },
  );
}

function fileDate() {
  return new Date().toISOString().slice(0, 10);
}

function plansForScope(workspacePlans: EmployeePlan[], scope: string, accessHrId: string | null | undefined, canAcknowledgeHr: boolean) {
  if (scope === "own") return workspacePlans.filter((plan) => hrIdsMatch(plan.employeeHrId, accessHrId));
  if (scope === "manager") return workspacePlans.filter((plan) => plan.status === "submitted" && hrIdsMatch(plan.managerHrId, accessHrId));
  if (scope === "ceo") {
    // A District Manager plan under a manager with a second approver waits on THAT approver, not the CEO.
    return workspacePlans.filter((plan) => {
      if (plan.status !== "manager_approved") return false;
      if (!planHasSecondApprover(plan.managerHrId, isDistrictManagerPlanTitle(plan.employeeJobTitle))) return true;
      return isSecondApproverForManager(accessHrId, plan.managerHrId);
    });
  }
  if (scope === "hr") return canAcknowledgeHr ? workspacePlans.filter((plan) => ["final_approved", "hr_acknowledged"].includes(plan.status)) : [];
  return workspacePlans;
}

function scopeLabel(scope: string, planId: string | null) {
  if (planId) return "Selected plan";
  switch (scope) {
    case "own":
      return "My Plans";
    case "manager":
      return "Manager review";
    case "ceo":
      return "CEO review";
    case "hr":
      return "HR acknowledgement";
    default:
      return "All visible plans";
  }
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:weekly-plans" });
    const url = new URL(request.url);
    const format = url.searchParams.get("format") === "pdf" ? "pdf" : "xlsx";
    const planId = url.searchParams.get("planId");
    const scope = url.searchParams.get("scope") ?? "all";
    const workspace = await getEmployeePlansWorkspace(access);
    if (!workspace.schemaReady) {
      return NextResponse.json(
        { error: "planning_schema_missing", message: "Planning database migration is not applied yet.", success: false },
        { status: 503 },
      );
    }

    const plans = planId
      ? workspace.plans.filter((plan) => plan.id === planId)
      : plansForScope(workspace.plans, scope, access.hrId, workspace.canAcknowledgeHr);
    if (planId && plans.length === 0) {
      return NextResponse.json(
        { error: "forbidden", message: "Forbidden: this plan is not available for export.", success: false },
        { status: 403 },
      );
    }

    const exportOptions = {
      medicalRepOptions: workspace.medicalRepOptions,
      scopeLabel: scopeLabel(scope, planId),
    };

    if (format === "pdf") {
      const pdf = await buildEmployeePlansPdf(plans, exportOptions);
      return new Response(pdf, {
        headers: {
          ...DOWNLOAD_NO_STORE_HEADERS,
          "Content-Disposition": `attachment; filename="phoenix-weekly-monthly-plans-${fileDate()}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    const workbook = await buildEmployeePlansWorkbook(plans, exportOptions);
    return new Response(workbook, {
      headers: {
        ...DOWNLOAD_NO_STORE_HEADERS,
        "Content-Disposition": `attachment; filename="phoenix-weekly-monthly-plans-${fileDate()}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: error.message },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return jsonError(error);
  }
}
