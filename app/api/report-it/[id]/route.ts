import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getReport } from "@/lib/report-it/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = clientSafeErrorMessage(error, fallback);
  const isForbidden = message.startsWith("Forbidden:");
  if (isForbidden) return NextResponse.json({ error: message }, { status: 403 });
  if (message.toLowerCase().includes("authentication")) return NextResponse.json({ error: message }, { status: 401 });
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) {
      return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
    }

    const { id } = await params;
    const report = await getReport(access, id);

    if (!report) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    return NextResponse.json(report);
  } catch (error) {
    return jsonError(error, "Failed to fetch report.");
  }
}
