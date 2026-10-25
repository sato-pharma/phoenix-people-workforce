// The payslip as a web page. The DOCUMENT itself lives in `@/lib/payroll/payslip-document` — this
// file resolves who is asking, which batch and which records, then serves what that module built.
//
// It used to carry ~600 lines of markup and stylesheet of its own, and a second, unrelated drawing
// of the same document sat in `./image/route.ts`. One document, one definition, two transports.

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isDevelopment } from "@/lib/env";
import { buildPayslipDocument, isPublishedPayslipStatus } from "@/lib/payroll/payslip-document";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SalaryRecord } from "@/lib/payroll/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLikelyUuidError(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes("invalid input syntax for type uuid") || normalized.includes("malformed uuid");
}

/**
 * Narrow a batch to the records the query names.
 *
 * Stays here rather than in the document module because it reads the REQUEST — that module is
 * handed records and knows nothing about URLs.
 */
export function filterPayslipRecords(records: SalaryRecord[], requestUrl: string) {
  const url = new URL(requestUrl);
  const employeeHrId = url.searchParams.get("employeeHrId")?.trim().toLowerCase() ?? "";
  const employeeName = url.searchParams.get("employeeName")?.trim().toLowerCase() ?? "";

  return records.filter((record) => {
    // HR ids are MIXED CASE in this database, so both sides are lowered before comparing — a plain
    // equality here silently under-returns.
    const matchesHrId =
      !employeeHrId ||
      record.hrId.toLowerCase() === employeeHrId ||
      record.employeeCode.toLowerCase() === employeeHrId;
    const matchesName = !employeeName || record.fullName.toLowerCase().includes(employeeName);
    return matchesHrId && matchesName;
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payslips", "read");
    const { id } = await params;
    batchId = id;

    if (isDevelopment) {
      console.debug("[employee-portal] API GET /api/payroll/[id]/payslips:", {
        batchId: id,
        user: access.loginId,
        role: access.role,
        hrId: access.hrId,
      });
    }

    const exportData = await getSalaryBatchExport(id, access);
    if (exportData && !isPublishedPayslipStatus(exportData.batch.status)) {
      return NextResponse.json(
        {
          error: "payslips_not_published",
          message: "Payslips are available only after payroll is approved or locked.",
        },
        { status: 409 },
      );
    }

    const records = exportData ? filterPayslipRecords(exportData.records, request.url) : [];

    if (!exportData || records.length === 0) {
      if (isDevelopment) {
        console.debug("[employee-portal] API GET /api/payroll/[id]/payslips: No records found or not found.");
      }
      return NextResponse.json(
        { error: "not_found", message: "No payslip records found for this batch and user." },
        { status: 404 },
      );
    }

    return new Response(
      buildPayslipDocument(records, exportData.batch.month, exportData.batch.year, exportData.batch.status),
      {
        headers: {
          // A payslip is one person's salary: never kept by the browser's back/forward cache, a shared
          // PC's disk cache or any proxy on the way (cache audit, 2026-10-26).
          "Cache-Control": "private, no-store",
          "Content-Type": "text/html; charset=utf-8",
        },
      },
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return "Unknown payroll API error.";
            }
          })();
    const responseMessage = isDevelopment ? message : "Failed to load payslip";

    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: responseMessage }, { status: 403 });
    }

    if (isDevelopment && isLikelyUuidError(message)) {
      return NextResponse.json(
        { error: "payslips_failed", message: "Invalid batch identifier format." },
        { status: 400 },
      );
    }

    if (isDevelopment) {
      console.error("[employee-portal] /api/payroll/[id]/payslips failed", {
        batchId,
        error,
      });
    }

    return NextResponse.json({ error: "payslips_failed", message: responseMessage }, { status: 500 });
  }
}
