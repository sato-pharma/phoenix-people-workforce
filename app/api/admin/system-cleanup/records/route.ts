import { NextResponse, type NextRequest } from "next/server";

import {
  listCleanupRecords,
  parseCleanupFilters,
} from "@/lib/admin/system-cleanup";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "System cleanup records failed to load.";
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden", message }, { status: 403 });
  }
  return NextResponse.json({ error: "cleanup_records_failed", message }, { status: 500 });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    const filters = parseCleanupFilters(request.nextUrl.searchParams);
    return NextResponse.json(await listCleanupRecords(access, filters));
  } catch (error) {
    return errorResponse(error);
  }
}
