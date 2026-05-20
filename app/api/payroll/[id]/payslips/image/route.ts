import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isDevelopment } from "@/lib/env";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  filterPayslipRecords,
  isPublishedPayslipStatus,
  periodLabel,
  renderPayslipsPage,
} from "../route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilePart(value: string) {
  return value
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "payslip";
}

async function renderPng(html: string) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: { height: 900, width: 1100 },
    });
    await page.emulateMedia({ media: "screen" });
    await page.setContent(html, { waitUntil: "networkidle" });

    const payslip = page.locator(".payslip").first();
    await payslip.waitFor({ state: "visible", timeout: 10000 });

    return await payslip.screenshot({
      animations: "disabled",
      type: "png",
    });
  } finally {
    await browser.close();
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payslips", "export");

    if (access.role !== "Super Admin") {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "Only Super Admin can export payslips as images.",
        },
        { status: 403 },
      );
    }

    const { id } = await params;
    batchId = id;
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
      return NextResponse.json(
        { error: "not_found", message: "No payslip records found for this batch and user." },
        { status: 404 },
      );
    }

    if (records.length > 1) {
      return NextResponse.json(
        {
          error: "single_payslip_required",
          message: "Choose one employee before exporting a payslip image.",
        },
        { status: 400 },
      );
    }

    const origin = new URL(request.url).origin;
    const html = renderPayslipsPage(
      records,
      exportData.batch.month,
      exportData.batch.year,
      exportData.batch.status,
      { baseHref: `${origin}/`, mode: "image" },
    );
    const png = await renderPng(html);
    const employee = safeFilePart(records[0].hrId || records[0].employeeCode || records[0].fullName);
    const period = safeFilePart(periodLabel(exportData.batch.month, exportData.batch.year));

    return new Response(new Uint8Array(png), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-payslip-${employee}-${period}.png"`,
        "Content-Type": "image/png",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to export payslip image.";
    const responseMessage = isDevelopment ? message : "Failed to export payslip image.";

    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: responseMessage }, { status: 403 });
    }

    if (isDevelopment) {
      console.error("[admin] /api/payroll/[id]/payslips/image failed", {
        batchId,
        error,
      });
    }

    return NextResponse.json({ error: "payslip_image_failed", message: responseMessage }, { status: 500 });
  }
}
