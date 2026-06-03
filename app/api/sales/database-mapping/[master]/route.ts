import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isMasterKey } from "@/lib/sales/master-data/definitions";
import { listMasterRows } from "@/lib/sales/master-data/list";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ master: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const { master } = await context.params;
    if (!isMasterKey(master)) {
      return NextResponse.json({ success: false, error: "Unknown master table." }, { status: 404 });
    }

    const data = await listMasterRows(master);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to load master rows." },
      { status: 500 },
    );
  }
}
