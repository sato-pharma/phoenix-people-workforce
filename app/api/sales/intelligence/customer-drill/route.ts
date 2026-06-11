import { NextResponse } from "next/server";

import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiCustomerDrill } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "";
  const client = (url.searchParams.get("client") ?? "").trim();
  const distributor = (url.searchParams.get("distributor") ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ success: false, error: "A concrete YYYY-MM period is required." }, { status: 400 });
  }
  if (!client || !distributor) {
    return NextResponse.json({ success: false, error: "Client and distributor codes are required." }, { status: 400 });
  }
  return handleSiRequest(request, (scope) => getSiCustomerDrill(period, scope, client, distributor));
}
