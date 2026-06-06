import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildEmployeePlansPdf, buildEmployeePlansWorkbook } from "@/lib/weekly-planning/export";
import { getEmployeePlansWorkspace, type EmployeePlan } from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to export weekly/monthly plans.";
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
  if (scope === "own") return workspacePlans.filter((plan) => plan.employeeHrId === accessHrId);
  if (scope === "manager") return workspacePlans.filter((plan) => plan.status === "submitted" && plan.managerHrId === accessHrId);
  if (scope === "ceo") return workspacePlans.filter((plan) => plan.status === "manager_approved");
  if (scope === "hr") return canAcknowledgeHr ? workspacePlans.filter((plan) => ["final_approved", "hr_acknowledged"].includes(plan.status)) : [];
  return workspacePlans;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
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

    if (format === "pdf") {
      const pdf = buildEmployeePlansPdf(plans);
      return new Response(pdf, {
        headers: {
          "Content-Disposition": `attachment; filename="phoenix-weekly-monthly-plans-${fileDate()}.pdf"`,
          "Content-Type": "application/pdf",
        },
      });
    }

    const workbook = await buildEmployeePlansWorkbook(plans);
    return new Response(workbook, {
      headers: {
        "Content-Disposition": `attachment; filename="phoenix-weekly-monthly-plans-${fileDate()}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
