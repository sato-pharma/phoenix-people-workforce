import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiMovers } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Movers load the prior month's full fact aggregate (a second heavy scan) — give it room.
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period) => getSiMovers(period, scope));
}
