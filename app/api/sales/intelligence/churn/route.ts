import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiCustomerChurn } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Churn loads TWO per-customer aggregates (current + prior) sequentially — the heaviest pair.
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period) => getSiCustomerChurn(period, scope));
}
