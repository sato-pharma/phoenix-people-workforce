import { NextResponse } from "next/server";

import { jsonError } from "@/app/api/territory-management/_lib/route-utils";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { searchBricks } from "@/lib/territory-management/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "read");

    const query = new URL(request.url).searchParams.get("q") ?? "";
    return NextResponse.json({ results: await searchBricks(query) });
  } catch (error) {
    return jsonError(error, "Failed to search bricks.");
  }
}
