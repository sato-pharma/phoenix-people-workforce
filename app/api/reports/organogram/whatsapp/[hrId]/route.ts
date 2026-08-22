import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { hrIdsMatch } from "@/lib/hr-id";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLinesForEmployee,
} from "@/lib/reports/organogram";
import { toWhatsAppNumber, whatsAppChatUrl } from "@/lib/reports/organogram-whatsapp";
import { errorMessage, type VacancyReportData } from "@/lib/reports/vacancies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Open a WhatsApp chat with one person on the caller's organogram.
 *
 * This is a REDIRECT rather than a JSON endpoint returning a number, and that is the
 * whole point of it. The chart never receives anybody's mobile: `OrganogramWorkFields`
 * carries only a `hasWhatsApp` boolean, so a viewer's browser holds a reachability flag
 * for their line and not a harvestable list of ~50 personal numbers. The number is
 * resolved here, per press, for one person the caller can already open a profile on.
 *
 * The gate is a deliberate copy of the sibling profile route
 * (../employee/[hrId]/route.ts): same permission, same scoped-chart resolution, same
 * "is this person actually on your chart" test with the same 404-not-403 answer. Reading
 * a colleague's mobile through this route is therefore exactly as permitted as reading it
 * in the node popup's Contact section, where it has always been visible — this changes
 * the ergonomics of reaching one number, never who may see it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  const { hrId } = await params;

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "organogram", "read");

    let report: VacancyReportData;
    if (canAccessCompanyOrganogram(access)) {
      report = await getOrganogramReport(access, { mode: "company" });
    } else if (isLineScopedOrganogramRole(access)) {
      const lineNames = await resolveOrganogramLinesForEmployee(access);
      if (!lineNames || lineNames.length === 0) {
        return NextResponse.json(
          { error: "organogram_scope_missing", message: "Unable to resolve your Organogram line scope." },
          { status: 409 },
        );
      }
      report = await getOrganogramReport(access, { lineNames, mode: "line" });
    } else {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have organogram access." },
        { status: 403 },
      );
    }

    const isOnViewerChart = report.organogramRows.some(
      (row) => row.type === "employee" && hrIdsMatch(row.hrId, hrId),
    );
    if (!isOnViewerChart) {
      // 404, not 403 — do not confirm the existence of a person the viewer cannot see.
      return NextResponse.json(
        { error: "not_found", message: "Employee is not in your organogram." },
        { status: 404 },
      );
    }

    const directory = await getEmployeeDirectory();
    const employee = directory.employees.find((candidate) => hrIdsMatch(candidate.hrId, hrId));
    const number = toWhatsAppNumber(employee?.mobileNumber);
    if (!number) {
      // Reached only from a stale tab: the button renders off `hasWhatsApp`, which is
      // false for both the 26 people with no number and the 2 whose number cannot be
      // read. Answering plainly beats bouncing the user into a chat with a stranger.
      return NextResponse.json(
        {
          error: "whatsapp_number_unavailable",
          message: "No usable WhatsApp number is on file for this employee.",
        },
        { status: 404 },
      );
    }

    // The destination is built from digits this request validated against the Egyptian
    // mobile pattern, so it cannot be steered anywhere but wa.me — the hrId never
    // reaches the URL.
    return NextResponse.redirect(whatsAppChatUrl(number), 302);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to organogram reports." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "organogram_whatsapp_failed", message: errorMessage(error) },
      { status: 500 },
    );
  }
}
