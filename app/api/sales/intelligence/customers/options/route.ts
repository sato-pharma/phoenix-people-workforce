import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiCustomerOptions } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The per-customer scan is the heaviest SI read (~7s on the full dataset); give it room. The panel
// fetches this once and filters in the browser, so it never runs per keystroke.
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period) => getSiCustomerOptions(period, scope));
}
