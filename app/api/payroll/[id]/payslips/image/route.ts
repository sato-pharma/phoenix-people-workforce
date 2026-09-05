// The payslip as a filed PDF.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THIS ROUTE NO LONGER DRAWS ANYTHING. It used to hold a second, hand-drawn pdf-lib rendering of the
// payslip — its own palette, its own field order, its own page geometry — beside the HTML sheet in
// `../route.ts`. Two drawings of one document drift apart, silently, because nobody opens both in
// the same afternoon; they already had, on colour and on which columns appeared.
//
// Now Chromium prints the SAME HTML the browser serves, exactly as the signed hiring papers are
// filed (`src/lib/hiring-pack/paper-pdf.ts`). Three things follow that the pdf-lib sheet could not
// do at any price:
//
//   ARABIC. `StandardFonts.Helvetica` is WinAnsi-encoded and cannot represent an Arabic codepoint,
//   which is why the old file carried an `asciiSafe()` that stripped every non-Latin character
//   before drawing. The amount in words — "فقط خمسة عشر ألفاً وثلاثمائة جنيه مصري لا غير" — would
//   have come out empty, and the document's own Arabic title with it. A PDF library would emit the
//   letters isolated and in visual order even with a Unicode font embedded; the browser is the only
//   thing in this stack that shapes and orders Arabic correctly.
//
//   NO ELLIPSIS. The old renderer measured each string and, when it overran its column, cut it and
//   appended "..". That is against the owner's standing rule, and on a payslip the cut value was a
//   name or a component. Chromium wraps.
//
//   ONE DOCUMENT. Any future change to the payslip lands in both outputs by construction.
//
// `printBackground` is not optional: the 6 % zebra row is a CSS background, and without it the
// detail tables print as unruled text.

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isDevelopment } from "@/lib/env";
import { canExportPayslipDocument } from "@/lib/payroll/payslip-center";
import { buildPayslipDocument, isPublishedPayslipStatus, periodLabel } from "@/lib/payroll/payslip-document";
import { getSalaryBatchExport } from "@/lib/payroll/service";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SalaryBatch, SalaryRecord } from "@/lib/payroll/types";
import { filterPayslipRecords } from "../route";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "payslip";
}

/**
 * One payslip, rendered by Chromium.
 *
 * The mark is inlined first because `setContent` gives the page no base URL, so `/brand/…` would
 * resolve against nothing and the letterhead would print without the logo — a blank corner that
 * reads as a broken template. `inlineLocalAssets` is the same allow-listed inliner the hiring papers
 * use, and the vector mark is already on its list.
 */
async function renderPayslipPdf(
  record: SalaryRecord,
  month: number,
  year: number,
  batchStatus: SalaryBatch["status"],
): Promise<Uint8Array> {
  const { html } = inlineLocalAssets(buildPayslipDocument([record], month, year, batchStatus));

  return withChromiumPage(async (page) => {
    // `domcontentloaded`, never `networkidle0`: after the inlining above the document makes no
    // network requests at all, so waiting for the network to fall idle waits for something that
    // already happened.
    await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
    // Chromium applies `@media screen` by default even when producing a PDF, and this document's
    // screen rules give it a grey ground and a border. Print is the medium being produced.
    await page.emulateMediaType("print");
    // Fonts are still in flight at `domcontentloaded` and they move type on the page. Waiting for
    // them and then one frame lets the layout settle; `document.fonts.ready` resolves immediately
    // when there is nothing to load, so this costs nothing when there is not.
    await page.evaluate(
      "(async () => { try { await document.fonts.ready; } catch {} "
        + "await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))); })()",
    );

    return page.pdf({
      // The zebra row, the brand rules and every hairline are CSS backgrounds or borders. Without
      // this the sheet prints as bare text.
      printBackground: true,
      // The document declares `@page { size: A4; margin: 0 }` and holds its own 12/13 mm padding.
      // Passing a margin here would be a value that silently loses to the sheet's own rule.
      preferCSSPageSize: true,
      timeout: 30_000,
    });
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let batchId = "";

  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payslips", "export");

    // Shared predicate, not a role literal: the admin page derives its own button visibility from
    // this same function, so the two cannot drift. See canExportPayslipDocument for why this is
    // narrower than Payslips Center page access (the CEO reads the Center but must not carry the
    // document out).
    if (!canExportPayslipDocument(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "You are not allowed to export payslip documents." },
        { status: 403 },
      );
    }

    const { id } = await params;
    batchId = id;
    const exportData = await getSalaryBatchExport(id, access);

    if (exportData && !isPublishedPayslipStatus(exportData.batch.status)) {
      return NextResponse.json(
        { error: "payslips_not_published", message: "Payslips are available only after payroll is approved or locked." },
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
        { error: "single_payslip_required", message: "Choose one employee before exporting a payslip." },
        { status: 400 },
      );
    }

    const pdf = await renderPayslipPdf(
      records[0],
      exportData.batch.month,
      exportData.batch.year,
      exportData.batch.status,
    );

    const employee = safeFilePart(records[0].hrId || records[0].employeeCode || records[0].fullName);
    const period   = safeFilePart(periodLabel(exportData.batch.month, exportData.batch.year));

    return new Response(new Uint8Array(pdf), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-payslip-${employee}-${period}.pdf"`,
        "Content-Type": "application/pdf",
      },
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Failed to export payslip.");
    const responseMessage = isDevelopment ? message : "Failed to export payslip.";

    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: responseMessage }, { status: 403 });
    }

    // Chromium missing is an infrastructure fact, not a bad request, and it is the one failure the
    // person clicking Export can do nothing about — so it says so plainly, and points at the route
    // that still works, instead of arriving as "Failed to export payslip."
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json(
        {
          error: "pdf_unavailable",
          message: "This server cannot render PDFs right now. The payslip page itself still opens and prints.",
        },
        { status: 503 },
      );
    }

    if (isDevelopment) {
      console.error("[admin] /api/payroll/[id]/payslips/image failed", { batchId, error });
    }

    return NextResponse.json({ error: "payslip_image_failed", message: responseMessage }, { status: 500 });
  }
}
