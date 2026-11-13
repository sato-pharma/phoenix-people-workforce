import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  EMPLOYEE_ORG_SELECT,
  resolveEmployeeAreaName,
  resolveEmployeeDepartmentName,
  resolveEmployeeLineName,
} from "@/lib/employees/employee-org-labels";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { reportItJsonError, reportItSignedOut } from "@/lib/report-it/http";
import { REPORT_IT_MAX_PAYLOAD_BYTES, reportPayloadRefusal, submitReport } from "@/lib/report-it/service";
import type { ReportItPayload } from "@/lib/report-it/types";
import { assertApiRateLimit } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) return reportItSignedOut();
    // The boundary: the role must hold report_it:create, checked here before anything is stored.
    await assertPermission(access, "report_it", "create");
    // A person files a handful of reports a day at most; this stops a script, never a reporter.
    await assertApiRateLimit({ identifier: access.hrId, limit: 10, scope: "report-it-submit", windowMs: 10 * 60_000 });

    const raw = await request.text();
    if (raw.length > REPORT_IT_MAX_PAYLOAD_BYTES + 1_000) {
      return NextResponse.json({ error: "The report is too large." }, { status: 413 });
    }
    let body: { payload?: unknown } | null = null;
    try {
      body = JSON.parse(raw) as { payload?: unknown };
    } catch {
      body = null;
    }
    const refusal = reportPayloadRefusal(body?.payload);
    if (refusal) return NextResponse.json({ error: refusal }, { status: 400 });
    const payload = body?.payload as ReportItPayload;

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
      payload,
      submitterHrId: access.hrId,
      submitterName: emp?.full_name ?? null,
      submitterRole: access.role,
      department: resolveEmployeeDepartmentName(emp),
      line: resolveEmployeeLineName(emp),
      area: resolveEmployeeAreaName(emp),
    });

    return NextResponse.json({ reportNumber: result.reportNumber, id: result.id }, { status: 201 });
  } catch (error) {
    return reportItJsonError(error, "Failed to submit report.");
  }
}
