import { downloadError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
import { isRealCalendarDate, parseBankFileScope } from "@/lib/automated-payroll/finance-links";
import { buildFabSheet } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** FAB bank-transfer file download. ?month=&year=&scope=part1|part2&valueDate=YYYY-MM-DD */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const month = Number(url.searchParams.get("month"));
    const year = Number(url.searchParams.get("year"));
    if (!Number.isInteger(month) || !Number.isInteger(year)) {
      return downloadError(request, new Error("Validation: month and year are required."));
    }
    // An unknown word is refused, never read as Part 1 — that default once paid every First Part twice.
    const scope = parseBankFileScope(url.searchParams.get("scope"));
    if (!scope) {
      return downloadError(request, new Error("Validation: scope must be part1 or part2."));
    }
    const valueDateParam = url.searchParams.get("valueDate");
    if (valueDateParam && !isRealCalendarDate(valueDateParam)) {
      return downloadError(request, new Error("Validation: valueDate must be a real date, YYYY-MM-DD."));
    }
    const { buffer, coverage, fileName } = await buildFabSheet(access, { month, year }, scope, valueDateParam ?? undefined);
    // Coverage travels with the download: a file missing people used to arrive completely clean.
    return xlsxResponse(buffer, fileName, [coverage]);
  } catch (error) {
    return downloadError(request, error, "Failed to download the FAB sheet.");
  }
}
