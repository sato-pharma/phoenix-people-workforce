import { NextResponse } from "next/server";

import { getErrorEvents, type ErrorEventSource } from "@/lib/error-monitor/service";
import { canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseSource(value: string | null): ErrorEventSource | null {
  return value === "server" || value === "client" ? value : null;
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (!await canAccess(access, "admin", "read")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const url = new URL(request.url);
    const filter = {
      dateFrom: url.searchParams.get("dateFrom") || null,
      dateTo: url.searchParams.get("dateTo") || null,
      hrId: url.searchParams.get("hrId") || null,
      moduleKey: url.searchParams.get("module") || null,
      page: Number(url.searchParams.get("page") ?? "1"),
      pageSize: Number(url.searchParams.get("pageSize") ?? "50"),
      source: parseSource(url.searchParams.get("source")),
    };

    const result = await getErrorEvents(filter);
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load error events." },
      { status: 500 },
    );
  }
}
