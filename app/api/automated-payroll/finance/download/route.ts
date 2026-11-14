import { downloadError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
import { parseFinanceSheetScope } from "@/lib/automated-payroll/finance-links";
import { buildFinanceSheet } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Finance locked-sheet download. ?month=&year=&scope=part1|full. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const month = Number(url.searchParams.get("month"));
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return downloadError(request, new Error("Validation: month and year are required."));
    }
    // Its own vocabulary, part1 | full — and any other word is refused rather than guessed.
    const scope = parseFinanceSheetScope(url.searchParams.get("scope"));
    if (!scope) {
      return downloadError(request, new Error("Validation: scope must be part1 or full."));
    }
    const { buffer, coverage, fileName } = await buildFinanceSheet(access, { month, year }, scope);
    // Coverage travels with the download: this workbook's TOTALS row counts money the bank files
    // may not carry, so the answer has to arrive with the file rather than be looked for.
    return xlsxResponse(buffer, fileName, coverage);
  } catch (error) {
    return downloadError(request, error, "Failed to download the finance sheet.");
  }
}
