import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiCustomerInsights } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The per-customer aggregate is the heaviest SI scan (~7s on the full dataset); give it room.
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period, filters) => getSiCustomerInsights(period, scope, filters));
}
