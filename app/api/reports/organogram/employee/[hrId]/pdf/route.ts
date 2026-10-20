import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import {
  assertPermission,
  isSalaryRedactedForViewer,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { hrIdsMatch } from "@/lib/hr-id";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import {
  canAccessCompanyOrganogram,
  canViewOrganogramSensitiveFields,
  getOrganogramReport,
  isLineScopedOrganogramRole,
  resolveOrganogramLinesForEmployee,
} from "@/lib/reports/organogram";
import { buildOrganogramEmployeeDetail } from "@/lib/reports/organogram-employee-detail";
import {
  buildOrganogramEmployeeDocument,
  organogramRecordContentDisposition,
} from "@/lib/reports/organogram-employee-document";
import {
  errorMessage,
  isDatabaseSchemaMissing,
  isSupabaseEnvMissing,
  isSupabaseTimeout,
  type VacancyReportData,
} from "@/lib/reports/vacancies";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A single person's record is one A4 page; the offer letter and the payslip render well inside this.
export const maxDuration = 60;

function reportError(error: unknown) {
  if (isSupabaseTimeout(error)) {
    return { message: "Supabase request timed out. Check your connection and try again.", status: 504 };
  }
  if (isSupabaseEnvMissing(error)) {
    return { message: "Supabase environment variables are missing.", status: 409 };
  }
  if (isDatabaseSchemaMissing(error)) {
    return { message: "Supabase schema is not ready.", status: 409 };
  }
  return { message: errorMessage(error), status: 500 };
}

/**
 * GET /api/reports/organogram/employee/[hrId]/pdf — the record popup, as a house document.
 *
 * 🔴 THE AUTHORISATION IS THE JSON ROUTE'S, LINE FOR LINE, and that is deliberate rather than
 * convenient. The popup and this download must show the same person the same fields to the same
 * viewer: the permission, the scoped chart, the on-chart check, and the `canViewSensitive`/
 * `redactSalary` pair are copied from `../route.ts` so a line manager's PDF carries exactly the org
 * and contact sections the popup gave them and never the Personal or Compensation ones. If either
 * side of that pair is ever tightened, BOTH routes have to change — they are two doors to one record.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ hrId: string }> },
) {
  const { hrId } = await params;

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "organogram", "read");

    // The exact scoped chart this viewer may see, then a check that the requested person is on it —
    // the same company-vs-line scoping as the chart route, so a line-scoped viewer can never pull a
    // record from outside their line, and Head-Office suppression is honoured.
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
        { error: "forbidden", message: "Organogram access is limited to National Sales Managers, Product Managers, and Group Product Managers." },
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
    if (!employee) {
      return NextResponse.json(
        { error: "not_found", message: "Employee record not found." },
        { status: 404 },
      );
    }

    const canViewSensitive = canViewOrganogramSensitiveFields(access);
    const detail = buildOrganogramEmployeeDetail(employee, {
      canViewSensitive,
      // The seat that never sees a salary gets no money row at all, not a column of blanks.
      omitSalary: isSalaryBlindRole(access.role),
      redactSalary: canViewSensitive && isSalaryRedactedForViewer(access, employee.hrId),
    });

    // The Sato mark and the Arabic watermark are `/brand/…` paths, and `setContent` gives the page no
    // base URL, so on their own they print as broken images (the 2026-10-13 premium dress made the
    // record carry both). They are inlined from `public/brand/` first — the same allow-listed inliner
    // the hiring papers and the payslip image use — which is also what leaves the page nothing to fetch.
    const { html } = inlineLocalAssets(buildOrganogramEmployeeDocument(detail));
    const pdf = await withChromiumPage(async (page) => {
      // `domcontentloaded`, not `networkidle0`: the document embeds its own stylesheet and, with its
      // artwork inlined, has no network request left to wait for. Waiting for network idle would add
      // seconds and hang the download for nothing.
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
      // Chromium applies `@media screen` by default even when producing a PDF; the document's paper
      // rules live under print.
      await page.emulateMediaType("print");
      const bytes = await page.pdf({
        format: "A4",
        // The margins live in the document's own `@page` rule (0; the sheet carries its own padding),
        // and `preferCSSPageSize` is what makes that rule win over the format above.
        margin: { bottom: "0", left: "0", right: "0", top: "0" },
        preferCSSPageSize: true,
        // The identity is line and type, but the 6% zebra and the letterhead rule are CSS
        // backgrounds — without this they drop out and the house look is lost on paper.
        printBackground: true,
        timeout: 30_000,
      });
      return Buffer.from(bytes);
    });

    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": organogramRecordContentDisposition(detail),
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to organogram reports." },
        { status: 403 },
      );
    }
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        { error: "pdf_unavailable", message: "The record PDF could not be produced right now. Please try again." },
        { status: 503 },
      );
    }

    const { message, status } = reportError(error);
    return NextResponse.json({ error: "organogram_employee_pdf_failed", message }, { status });
  }
}
