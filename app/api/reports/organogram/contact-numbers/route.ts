import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { writeRequiredAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import {
  canAccessCompanyOrganogram,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLinesForEmployee,
} from "@/lib/reports/organogram";
import { toDialableLocalMobile } from "@/lib/reports/organogram-whatsapp";
import { errorMessage, type VacancyReportData } from "@/lib/reports/vacancies";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mobile numbers for the people on the caller's organogram, for the XLSX export only.
 *
 * ## Why this is a route and not a field on the row
 *
 * The owner asked (2026-08-23) for the mobile number to appear in the organogram export.
 * The sheet is built in the BROWSER, from the same `organogramRows` the chart renders —
 * so the obvious implementation, adding `mobileNumber` to `OrganogramWorkFields`, would
 * hand every viewer's page every colleague's number on every load, whether or not they
 * ever press Export. That is a standing list of ~50 personal numbers in the payload of a
 * page people leave open all day, and it is not what was asked for.
 *
 * Fetching them here instead means the numbers exist in a browser only in the seconds
 * between pressing Export and the file being written, and only for someone who pressed
 * it. The row itself stays clean, which `tests/organogram-whatsapp-gate.test.ts` pins.
 *
 * ## The gate
 *
 * Identical to the sibling WhatsApp route: same permission, same company-vs-line scope
 * resolution, and the same rule that you only ever learn about people already on your own
 * chart. A viewer therefore gets exactly the numbers they could already read one by one
 * in each person's profile panel — the export saves them fifty clicks, it does not widen
 * what they may see.
 *
 * ## The audit row is written HERE
 *
 * This is the one organogram route that returns personal contact details in bulk, so the
 * pull is recorded. Note that the `audit` entry in `access-registry.ts` does not do that:
 * the registry is a declarative inventory read by tests, and nothing in the request path
 * imports it. The `writeRequiredAuditLog` call below is what actually reaches
 * `audit_logs`, and it runs BEFORE the numbers are returned — a list of colleagues'
 * numbers that nobody can account for later is worse than a failed export.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "organogram", "read");
    await assertExportRateLimit({ actor: access.hrId, request, scope: "organogram-contact-numbers" });

    let report: VacancyReportData;
    let scope: string;
    if (canAccessCompanyOrganogram(access)) {
      report = await getOrganogramReport(access, { mode: "company" });
      scope = "company";
    } else if (isLineScopedOrganogramRole(access)) {
      const lineNames = await resolveOrganogramLinesForEmployee(access);
      if (!lineNames || lineNames.length === 0) {
        return NextResponse.json(
          { error: "organogram_scope_missing", message: "Unable to resolve your Organogram line scope." },
          { status: 409 },
        );
      }
      report = await getOrganogramReport(access, { lineNames, mode: "line" });
      scope = lineNames.join(", ");
    } else {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have organogram access." },
        { status: 403 },
      );
    }

    // The set of people this caller may learn about. Vacant seats hold nobody, so they
    // are excluded here rather than filtered later.
    const allowed = new Set<string>();
    for (const row of report.organogramRows) {
      if (row.type !== "employee") continue;
      const key = canonicalHrIdKey(row.hrId);
      if (key) allowed.add(key);
    }

    const directory = await getEmployeeDirectory();
    const contacts: Array<{ hrId: string; mobile: string }> = [];
    for (const employee of directory.employees) {
      const key = canonicalHrIdKey(employee.hrId);
      if (!key || !allowed.has(key)) continue;

      // Repaired local form when the stored value can be read with confidence; otherwise
      // the raw stored text, so the sheet is honest about what is on file rather than
      // showing an empty cell that reads as "no number on record". Nothing is guessed —
      // see toDialableLocalMobile.
      const repaired = toDialableLocalMobile(employee.mobileNumber);
      const stored = (employee.mobileNumber ?? "").trim();
      const mobile = repaired ?? stored;
      if (!mobile) continue;

      contacts.push({ hrId: employee.hrId, mobile });
    }

    await writeRequiredAuditLog({
      actorLoginId: access.loginId ?? access.hrId,
      entityType: "organogram_contact_export",
      entityId: randomUUID(),
      // Both counts, for the same reason the direct-orders export logs both: a later
      // question about a forwarded file is only answerable if the trail says how many
      // people were in reach as well as how many numbers were handed over.
      newValues: {
        chartPeople: allowed.size,
        numbersReturned: contacts.length,
        scope,
      },
      summary: `Organogram contact numbers exported (${contacts.length} numbers across ${allowed.size} people, scope ${scope}) by ${access.hrId ?? "unknown"}.`,
    });

    return NextResponse.json({ contacts });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many exports — please wait a minute." },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to organogram reports." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "organogram_contact_numbers_failed", message: errorMessage(error) },
      { status: 500 },
    );
  }
}
