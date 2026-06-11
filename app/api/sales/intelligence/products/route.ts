import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiProductPerformance } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period) => getSiProductPerformance(period, scope));
}
