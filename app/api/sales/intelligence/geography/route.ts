import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiGeography } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleSiRequest(request, (scope, period) => getSiGeography(period, scope));
}
