import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getDeductionInboxKpis,
  groupByEmployee,
  groupBySource,
  listDeductionCandidates,
  listDisputes,
  listFinalApprovedDecisions,
  listRecentAuditEvents,
  listRecentDeductionComments,
  sanitizeDeductionInboxFilters,
  type DeductionInboxFilters,
} from "@/lib/deductions-governance/service";
import {
  deductionDecisionStatuses,
  deductionSeverities,
  deductionSourceModules,
  deductionTypes,
  type DeductionDecisionStatus,
  type DeductionSeverity,
  type DeductionSourceModule,
  type DeductionType,
} from "@/lib/deductions-governance/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { message: (error as Error).message, success: false },
      { status: 403 },
    );
  }
  const message = clientSafeErrorMessage(error, fallback);
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) {
    return NextResponse.json({ message, success: false }, { status: 401 });
  }
  if (lower.includes("not found")) {
    return NextResponse.json({ message, success: false }, { status: 404 });
  }
  if (lower.includes("invalid") || lower.includes("required")) {
    return NextResponse.json({ message, success: false }, { status: 400 });
  }
  return NextResponse.json({ message, success: false }, { status: defaultStatus });
}

function parseFiltersFromUrl(url: URL): DeductionInboxFilters {
  const raw: DeductionInboxFilters = {};
  const monthKey = url.searchParams.get("monthKey");
  if (monthKey) raw.monthKey = monthKey;
  const sourceModule = url.searchParams.get("sourceModule");
  if (sourceModule && (deductionSourceModules as readonly string[]).includes(sourceModule)) {
    raw.sourceModule = sourceModule as DeductionSourceModule;
  }
  const deductionType = url.searchParams.get("deductionType");
  if (deductionType && (deductionTypes as readonly string[]).includes(deductionType)) {
    raw.deductionType = deductionType as DeductionType;
  }
  const decisionStatus = url.searchParams.get("decisionStatus");
  if (decisionStatus && (deductionDecisionStatuses as readonly string[]).includes(decisionStatus)) {
    raw.decisionStatus = decisionStatus as DeductionDecisionStatus;
  }
  const severity = url.searchParams.get("severity");
  if (severity && (deductionSeverities as readonly string[]).includes(severity)) {
    raw.severity = severity as DeductionSeverity;
  }
  const employeeSearch = url.searchParams.get("employeeSearch");
  if (employeeSearch) raw.employeeSearch = employeeSearch;
  const includeSuperseded = url.searchParams.get("includeSuperseded");
  if (includeSuperseded === "true") raw.includeSuperseded = true;
  return sanitizeDeductionInboxFilters(raw);
}

function parsePositiveInt(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");

    const url = new URL(request.url);
    const filters = parseFiltersFromUrl(url);
    const page = parsePositiveInt(url.searchParams.get("page"), 1);
    const pageSize = parsePositiveInt(url.searchParams.get("pageSize"), 50);

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
      listDeductionCandidates({ access, filters, page, pageSize }),
      groupBySource({ access, filters }),
      groupByEmployee({ access, filters, limit: 100 }),
      listFinalApprovedDecisions({ access, filters }),
      listDisputes({ access, filters }),
      listRecentAuditEvents({ access, monthKey: filters.monthKey, limit: 50 }),
      listRecentDeductionComments({ access, limit: 100 }),
    ]);

    return NextResponse.json({
      success: true,
      kpis,
      inbox,
      bySource,
      byEmployee,
      finalApproved,
      disputes,
      audit,
      comments,
    });
  } catch (error) {
    return jsonError(error, "Failed to load Deductions Governance Center.");
  }
}
