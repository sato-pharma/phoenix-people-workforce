import { NextResponse } from "next/server";

import { listSalesHistory, listSalesQueue } from "@/lib/sales/service";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const accessContext = await resolveAccessContext(request);
    await assertPermission(accessContext, "sales", "read");
    const url = new URL(request.url);
    const view = url.searchParams.get("view");
    const data = view === "queue" ? await listSalesQueue(accessContext) : await listSalesHistory(accessContext);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: clientSafeErrorMessage(error, "Failed to load sales imports."),
      },
      { status: 500 },
    );
  }
}
