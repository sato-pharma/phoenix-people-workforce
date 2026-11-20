import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { inlineLocalAssets } from "@/lib/hiring-pack/paper-artwork";
import { stampPremiumPageNumbers } from "@/lib/hiring-pack/paper-pdf";
import { assertExportRateLimit } from "@/lib/http/assert-export-rate-limit";
import { costLetterFileName, renderCostLetterHtml } from "@/lib/medical-insurance/cost-letter";
import { medicalInsuranceErrorResponse } from "@/lib/medical-insurance/route-helpers";
import { getMedicalInsuranceCostLetter } from "@/lib/medical-insurance/service";
import { ChromiumUnavailableError, withChromiumPage } from "@/lib/pdf/chromium";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/medical-insurance/cost-letter?member=<the employee's register row> — one employee's Medical Cover
 * Statement as a PDF: their grade, what they and their family cost them each month, and their grade's table
 * of benefits (owner, 2026-11-21). It shows amounts, never the split's percentages.
 *
 * 🔴 It carries amounts, so it is held to medical_insurance_invoices (Super Admin only), asserted here before
 * anything is read. It sends nothing: the Super Admin downloads it and hands it on.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "medical_insurance_invoices", "read");
    await assertExportRateLimit({ actor: access.loginId ?? access.hrId, request, scope: "export:medical-insurance-cost-letter" });

    const memberId = new URL(request.url).searchParams.get("member") ?? "";
    const letter = await getMedicalInsuranceCostLetter(memberId);
    const preparedOn = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());

    // `setContent` gives the page no origin, so the premium chrome's `/brand/...` images are inlined first.
    const { html } = inlineLocalAssets(renderCostLetterHtml(letter, preparedOn));
    const pdf = await withChromiumPage(async (page) => {
      await page.setContent(html, { timeout: 30_000, waitUntil: "domcontentloaded" });
      await page.emulateMediaType("print");
      // "N / M" is written into the premium foot after Chromium has counted the pages.
      await page.evaluate("document.documentElement.setAttribute('data-pm-numbered', '')");
      const bytes = await page.pdf({
        format: "A4",
        margin: { bottom: "0", left: "0", right: "0", top: "0" },
        preferCSSPageSize: true,
        printBackground: true,
        timeout: 60_000,
      });
      return Buffer.from(await stampPremiumPageNumbers(bytes));
    });

    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: memberId,
      entityType: "medical_insurance_export",
      summary: `Built the Medical Cover Statement for ${letter.employeeName}`,
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${costLetterFileName(letter)}"`,
        "content-type": "application/pdf",
        "x-content-type-options": "nosniff",
      },
      status: 200,
    });
  } catch (error) {
    if (error instanceof ChromiumUnavailableError) {
      return NextResponse.json({ error: "pdf_unavailable", message: "The PDF printer is not available right now. Try again in a minute." }, { status: 503 });
    }
    return medicalInsuranceErrorResponse(error, "medical_insurance_cost_letter_failed");
  }
}
