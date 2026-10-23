import { NextResponse } from "next/server";

import { assertWeeklyMappingTemplatePermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import {
  analyzeWeeklyForNormalization,
  buildWeeklyUnmappedWorkbook,
  listWeeklyNormalizeReferences,
} from "@/lib/sales/weekly/normalizer";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The unknowns from THIS weekly file as a fillable XLSX: one row per distinct unmapped item and per
// distinct unmapped branch, each answer column a dropdown over the live master lists. Fill it, then
// send it back to /mappings/learn.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // `update`, not `export`. The workbook this builds embeds the UNSCOPED master catalogue —
    // every product code/name/line, every region, every area — including the confidential Head
    // Office line (LA003/LA004/SS001) that access.ts strips from every dashboard tier. `export` is
    // held by Medical Rep upward, so gating on it handed that catalogue to the whole sales field.
    // Every sibling normalizer route (preview / save / learn / ai-suggest) already gates on `update`.
    // The CEO is allowed through explicitly — he is already cleared for the Head Office line but
    // does not hold `update`. See canAccessWeeklyMappingTemplate for why that is not widened.
    await assertWeeklyMappingTemplatePermission(access);

    const form = await request.formData();
    const distributorCode = String(form.get("distributorCode") ?? "").trim();
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const pick = (name: string) => {
      const value = form.get(name);
      return value instanceof File && value.size > 0 ? value : null;
    };
    const file = pick("file");
    const salesFile = pick("salesFile");
    const stockFile = pick("stockFile");
    if (!file && !salesFile && !stockFile) {
      return NextResponse.json({ success: false, error: "Choose a raw weekly file first." }, { status: 400 });
    }
    for (const candidate of [file, salesFile, stockFile]) {
      if (!candidate) continue;
      const validation = validateSpreadsheetFile(candidate, {
        ...xlsxSpreadsheetValidation,
        emptyError: "invalid_weekly_file",
        tooLargeMessage: spreadsheetTooLargeMessage("Weekly workbook"),
      });
      if (!validation.ok) {
        return NextResponse.json({ success: false, error: validation.message, code: validation.error }, { status: validation.status });
      }
    }

    const periodDate = String(form.get("periodDate") ?? "").trim() || null;
    const [preview, references] = await Promise.all([
      analyzeWeeklyForNormalization({ distributorCode, file, salesFile, stockFile, periodDate }),
      listWeeklyNormalizeReferences(),
    ]);
    const buffer = await buildWeeklyUnmappedWorkbook(preview, references);
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-weekly-unmapped-${preview.distributorCode}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    if (error instanceof SalesWorkflowError) {
      return NextResponse.json({ success: false, error: error.message, code: error.code }, { status: error.status });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build the unmapped list.") }, { status: 500 });
  }
}
