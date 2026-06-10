import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { submitReport } from "@/lib/report-it/service";
import type { ReportItPayload } from "@/lib/report-it/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isForbidden(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Forbidden:");
}

function jsonError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  if (isForbidden(error)) return NextResponse.json({ error: message }, { status: 403 });
  if (message.toLowerCase().includes("authentication")) return NextResponse.json({ error: message }, { status: 401 });
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);

    if (access.source === "guest" || !access.hrId) {
      return NextResponse.json({ error: "Authentication is required." }, { status: 401 });
    }

    const body = (await request.json()) as { payload?: unknown };
    if (!body?.payload || typeof body.payload !== "object") {
      return NextResponse.json({ error: "Missing report payload." }, { status: 400 });
    }

    // Fetch employee record for submitter metadata. Match on canonical hr_id
    // keys (case-insensitive + alias variants) so the name/department/line
    // populate even when the session hr_id differs in case from the stored
    // employee row (e.g. "ADMIN-HR" vs "admin-HR").
    const supabase = getSupabaseAdmin();
    const { data: empRows } = await supabase
      .from("employees")
      .select("name, line_name, area, department")
      .in("hr_id", hrIdLookupKeys(access.hrId))
      .limit(1);
    const emp = empRows?.[0] ?? null;

    const result = await submitReport({
      payload: body.payload as ReportItPayload,
      submitterHrId: access.hrId,
      submitterName: emp?.name ?? null,
      submitterRole: access.role,
      department: emp?.department ?? null,
      line: emp?.line_name ?? null,
      area: emp?.area ?? null,
    });

    return NextResponse.json({ reportNumber: result.reportNumber, id: result.id }, { status: 201 });
  } catch (error) {
    return jsonError(error, "Failed to submit report.");
  }
}
