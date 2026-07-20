import { jsonError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
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
      return jsonError(new Error("Validation: month and year are required."));
    }
    const scope = url.searchParams.get("scope") === "part1" ? "part1" : "full";
    const { buffer, fileName } = await buildFinanceSheet(access, { month, year }, scope);
    return xlsxResponse(buffer, fileName);
  } catch (error) {
    return jsonError(error, "Failed to download the finance sheet.");
  }
}
