import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  EMPLOYEE_ORG_SELECT,
  resolveEmployeeAreaName,
  resolveEmployeeDepartmentName,
  resolveEmployeeLineName,
} from "@/lib/employees/employee-org-labels";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { submitReport } from "@/lib/report-it/service";
import type { ReportItPayload } from "@/lib/report-it/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isForbidden(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Forbidden:");
}

function jsonError(error: unknown, fallback: string) {
  const message = clientSafeErrorMessage(error, fallback);
  if (isForbidden(error)) return NextResponse.json({ error: message }, { status: 403 });
  if (message.toLowerCase().includes("authentication")) return NextResponse.json({ error: message }, { status: 401 });
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) {
      return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
    }

    const body = (await request.json()) as { payload?: unknown };
    if (!body?.payload || typeof body.payload !== "object") {
      return NextResponse.json({ error: "Missing report payload." }, { status: 400 });
    }

    // Fetch employee record for submitter metadata. Match on canonical hr_id
    // keys (case-insensitive + alias variants) so the name/department/line
    // populate even when the session hr_id differs in case from the stored
    // employee row (e.g. "ADMIN-HR" vs "admin-HR").
    const supabase = getSupabaseAdmin();
    // 🔴 THIS SELECT NAMED THREE COLUMNS THAT DO NOT EXIST — `name`, `area` and `department`. The
    // table has `full_name`, `area_name` and `department_name`. PostgREST answers a missing column
    // with an error rather than a null, so `empRows` came back undefined and EVERY field below
    // resolved to null: an adverse-event report would have been filed with no submitter name, no
    // department, no line and no area on it. Nothing anywhere said so — the insert succeeded, the
    // response was 201, and the blanks read as "this person has no department". No report has been
    // submitted on production yet (0 rows on 2026-09-29), so nothing needs repairing; this is the
    // first real submission being fixed before it happens rather than after.
    //
    // The fourth column, `line_name`, exists and is DEAD — and so are its siblings: on production
    // 1 of 198 rows carries a line_name and 0 of 198 carry a department_name, against 181 and 180
    // real links. So the line, department and area are all resolved from the LINKS; see
    // employee-org-labels.ts.
    const { data: empRows, error: empError } = await supabase
      .from("employees")
      .select(`full_name,${EMPLOYEE_ORG_SELECT}`)
      .in("hr_id", hrIdLookupKeys(access.hrId))
      .limit(1);
    // Not fatal, deliberately: a patient-safety report must not be refused because the submitter's
    // own record could not be read. But it must not fail SILENTLY either, which is exactly what
    // hid the broken select — the report is still filed, with whatever metadata was resolved.
    if (empError) console.error("report-it: submitter lookup failed", empError);
    const emp = empRows?.[0] ?? null;

    const result = await submitReport({
      payload: body.payload as ReportItPayload,
      submitterHrId: access.hrId,
      submitterName: emp?.full_name ?? null,
      submitterRole: access.role,
      department: resolveEmployeeDepartmentName(emp),
      line: resolveEmployeeLineName(emp),
      area: resolveEmployeeAreaName(emp),
    });

    return NextResponse.json({ reportNumber: result.reportNumber, id: result.id }, { status: 201 });
  } catch (error) {
    return jsonError(error, "Failed to submit report.");
  }
}
