import { NextResponse } from "next/server";

import { listSalesHistory, listSalesQueue } from "@/lib/sales/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const data = view === "queue" ? await listSalesQueue() : await listSalesHistory();

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to load sales imports.",
      },
      { status: 500 },
    );
  }
}
