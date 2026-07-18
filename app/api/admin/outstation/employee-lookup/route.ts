import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "read");

    const { searchParams } = new URL(request.url);
    const hrId = searchParams.get("hrId")?.trim() ?? "";

    if (!hrId) {
      return NextResponse.json(
        { error: "missing_hr_id", message: "hrId is required." },
        { status: 400 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname, job_title, employment_status")
      .eq("hr_id", hrId.toUpperCase())
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { error: "lookup_failed", message: "Employee lookup failed." },
        { status: 500 },
      );
    }

    if (!data) {
      return NextResponse.json(
        { error: "not_found", message: "No employee found with this HR ID." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      hrId: data.hr_id,
      jobTitle: data.job_title ?? null,
      name: resolveEmployeeDisplayName(data.full_name, data.nickname),
      status: data.employment_status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Employee lookup failed.";
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "lookup_error", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
