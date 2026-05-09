import { NextResponse } from "next/server";

import { listSalesHistory, listSalesQueue } from "@/lib/sales/service";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const accessContext = await resolveAccessContext(request);
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const data = view === "queue" ? await listSalesQueue(accessContext) : await listSalesHistory(accessContext);

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
