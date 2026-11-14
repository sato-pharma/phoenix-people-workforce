import { downloadError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
import { parseBankFileScope } from "@/lib/automated-payroll/finance-links";
import { buildCibSheet } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CIB bank-transfer file download. ?month=&year=&scope=part1|part2 */
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
    const { buffer, coverage, fileName } = await buildCibSheet(access, { month, year }, scope);
    return xlsxResponse(buffer, fileName, [coverage]);
  } catch (error) {
    return downloadError(request, error, "Failed to download the CIB sheet.");
  }
}
