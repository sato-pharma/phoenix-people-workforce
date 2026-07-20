import { jsonError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
import { buildRunSheet } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the branded Part-1 or full monthly sheet (HR). ?variant=part1|full. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const variant = new URL(request.url).searchParams.get("variant") === "part1" ? "part1" : "full";
    const { buffer, fileName } = await buildRunSheet(access, runId, variant);
    return xlsxResponse(buffer, fileName);
  } catch (error) {
    return jsonError(error, "Failed to export the payroll sheet.");
  }
}
