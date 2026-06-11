import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiTrend } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Trend scans each available month sequentially; give the multi-period read room.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Trend is period-agnostic (it spans every validated month), so it ignores the period param.
  return handleSiRequest(request, (scope) => getSiTrend(scope));
}
