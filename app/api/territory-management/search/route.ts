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
    await assertPermission(access, "territory", "read");

    const params = new URL(request.url).searchParams;
    const query = params.get("q") ?? "";
    const lineCode = params.get("lineCode") ?? "";

    // Required, not optional: a hit's region only means anything against a line, and a default
    // would quietly label every brick with whichever line happened to come first.
    if (!lineCode) throw new Error("Invalid request: lineCode is required.");

    // The service re-checks the line against the caller's own scope, so a forged lineCode cannot
    // read a line the dropdown never offered them.
    return NextResponse.json({ results: await searchBricks({ access, lineCode, query }) });
  } catch (error) {
    return jsonError(error, "Failed to search bricks.");
  }
}
