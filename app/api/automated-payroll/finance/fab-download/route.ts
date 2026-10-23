import { downloadError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
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
    const scope = url.searchParams.get("scope") === "part2" ? "part2" : "part1";
    const valueDateParam = url.searchParams.get("valueDate");
    if (valueDateParam && !/^\d{4}-\d{2}-\d{2}$/.test(valueDateParam)) {
      return downloadError(request, new Error("Validation: valueDate must be YYYY-MM-DD."));
    }
    const { buffer, coverage, fileName } = await buildFabSheet(access, { month, year }, scope, valueDateParam ?? undefined);
    // Coverage travels with the download: a file missing people used to arrive completely clean.
    return xlsxResponse(buffer, fileName, [coverage]);
  } catch (error) {
    return downloadError(request, error, "Failed to download the FAB sheet.");
  }
}
