import { NextResponse } from "next/server";

import { handleSiRequest } from "@/lib/sales/intelligence/request";
import { getSiProductDrill } from "@/lib/sales/intelligence/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? "";
  const product = (url.searchParams.get("product") ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(period)) {
    return NextResponse.json({ success: false, error: "A concrete YYYY-MM period is required." }, { status: 400 });
  }
  if (!product) {
    return NextResponse.json({ success: false, error: "A product code is required." }, { status: 400 });
  }
  // The drill key travels as an opaque CODE; every displayed string in the response is a NAME.
  return handleSiRequest(request, (scope) => getSiProductDrill(period, scope, product));
}
