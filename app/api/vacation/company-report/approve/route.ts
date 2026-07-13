import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertSystemAdministratorWorkspaceAccess, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { COMPANY_VACATION_REPORT_CACHE_TAG } from "@/lib/vacation/company-vacation-report";
import { createVacationRequestAsAdmin, isVacationSchemaMissing, vacationErrorMessage } from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turns ONE unverified "CRM Signal" row from the Company Vacation Report into a real, approved
 * vacation_requests row — the human-reviewed alternative to bulk-writing every CRM signal
 * directly (explicitly rejected as unsafe: see the owner conversation this route was built
 * from). Every call here is one Super Admin's explicit, individual decision on one employee's
 * one date. Reuses createVacationRequestAsAdmin — the SAME balance-calculation path the
 * existing "Company Vacation Records" admin UI already uses — rather than computing
 * entitlement/balance math independently, per the domain-first rule (src/lib/vacation/service.ts
 * is the single source of truth for leave balance calculation).
 */
export async function POST(request: Request) {
  // Hoisted so the catch block can produce date-specific messages.
  let startDate = "";
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "vacation report approvals");

    const body = await request.json();
    const hrId = typeof body?.hrId === "string" ? body.hrId.trim() : "";
    startDate = typeof body?.startDate === "string" ? body.startDate : "";
    const endDate = typeof body?.endDate === "string" ? body.endDate : startDate;
    const workingDays = Number(body?.workingDays);
    const detail = typeof body?.detail === "string" ? body.detail : "";
    if (!hrId || !startDate || !endDate) {
      return NextResponse.json({ error: "invalid_request", message: "hrId, startDate, and endDate are required.", success: false }, { status: 400 });
    }
    if (![0.5, 1].includes(workingDays)) {
      return NextResponse.json({ error: "invalid_request", message: "workingDays must be 0.5 or 1 for a single CRM Signal row.", success: false }, { status: 400 });
    }

    // Overlap-containment guard (defends against double-deduction). The DB has a unique index on
    // the EXACT tuple (employee_hr_id, start_date, end_date) for active requests, so approving
    // the same single date twice collides and is rejected. But that index does NOT catch the
    // CONTAINMENT case: if an existing active (pending/approved) request already spans this CRM
    // date as part of a wider range (e.g. an approved D-1..D+1 covers D), a new (D,D) insert does
    // not collide, and the balance engine (approvedPaidDaysInPeriod) would then count day D twice
    // -> a persistent over-deduction. Report-level suppression only helps for ALREADY-approved
    // ranges and only after the cache refreshes, so enforce it here at write time too.
    // Match the same uppercased employee_hr_id convention approvedPaidDaysInPeriod uses, so this
    // catches exactly the rows that would otherwise be double-counted.
    const { data: overlapping, error: overlapError } = await getSupabaseAdmin()
      .from("v2_vacation_requests")
      .select("id,start_date,end_date,status")
      .eq("employee_hr_id", hrId.toUpperCase())
      .not("status", "in", "(rejected,cancelled)")
      .lte("start_date", startDate)
      .gte("end_date", startDate)
      .limit(1);
    if (overlapError) throw new Error(`Overlap check failed: ${overlapError.message}`);
    if (overlapping && overlapping.length > 0) {
      const existing = overlapping[0] as { end_date: string; id: string; start_date: string; status: string };
      return NextResponse.json({
        error: "already_covered",
        message: `${hrId} already has a ${existing.status} leave request (${existing.start_date} → ${existing.end_date}) that covers ${startDate}. Not creating a duplicate — no balance was changed.`,
        requestId: existing.id,
        success: false,
      }, { status: 409 });
    }

    const actorHrId = resolveEmployeeIdentityId(access);
    const actorLoginId = access.loginId ?? actorHrId ?? "system";
    const notes = `Approved from the Company Vacation Report (CRM signal review) by ${actorLoginId}. Original CRM detail: "${detail}".`;

    const created = await createVacationRequestAsAdmin(access, {
      dayPart: workingDays === 1 ? "full_day" : "pm_only",
      employeeHrId: hrId,
      endDate,
      notes,
      startDate,
      status: "approved",
      vacationType: "annual",
    });

    // createVacationRequestAsAdmin already writes its own "admin_created" audit log entry for
    // the request itself; this second entry records the review decision specifically — which
    // CRM signal was approved and by whom — for this report's own audit trail.
    await writeAuditLog({
      actorLoginId,
      entityId: created.id,
      entityType: "vacation_request",
      newValues: { detail, endDate, hrId, requestId: created.id, startDate, workingDays },
      summary: "Company vacation report: CRM signal approved and converted to a real vacation request.",
    });

    revalidateTag(COMPANY_VACATION_REPORT_CACHE_TAG, "max");

    return NextResponse.json({ request: created, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to approve this vacation signal.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    // createVacationRequestAsAdmin recomputes duration from the day part; on a weekly-off day (or
    // any date with no HR working day) that recompute throws a generic "must include at least one
    // working day". Map it to a clear, date-specific message so the admin understands nothing was
    // deducted and why, rather than seeing an opaque internal error.
    if (/working day/i.test(message)) {
      return NextResponse.json({
        error: "non_working_day",
        message: `${startDate || "This date"} is the employee's weekly rest day (or otherwise not a working day), so it can't be recorded as annual leave. No balance was changed.`,
        success: false,
      }, { status: 400 });
    }
    const apiError = toApiError(error, message);
    return NextResponse.json({ error: apiError.code, message, success: false }, { status: apiError.status });
  }
}
