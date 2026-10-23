import { NextResponse } from "next/server";

import { normalizeHrId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { ilikeContainsValue, ilikeExactValue } from "@/lib/supabase/search-filter";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertOutstationAdminAccess(access, "read");

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q")?.trim() ?? "";

    if (query) {
      if (query.length < 2) {
        return NextResponse.json({ matches: [] });
      }

      const supabase = getSupabaseAdmin();
      // Quoted, never spliced into the filter (technical audit, 2026-10-23, F-02).
      const normalized = ilikeExactValue(normalizeHrId(query) || query);
      const pattern = ilikeContainsValue(query);
      if (!normalized || !pattern) {
        return NextResponse.json({ matches: [] });
      }
      const { data, error } = await supabase
        .from("employees")
        .select("hr_id, full_name, nickname, job_title, employment_status")
        .or(`hr_id.ilike.${normalized},full_name.ilike.${pattern},nickname.ilike.${pattern}`)
        .limit(8);

      if (error) {
        return NextResponse.json(
          { error: "search_failed", message: "Employee search failed." },
          { status: 500 },
        );
      }

      return NextResponse.json({
        matches: (data ?? []).map((row) => ({
          hrId: row.hr_id,
          isActive: !isTerminalEmploymentStatus(row.employment_status),
          jobTitle: row.job_title ?? null,
          name: resolveEmployeeDisplayName(row.full_name, row.nickname),
        })),
      });
    }

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
      isActive: !isTerminalEmploymentStatus(data.employment_status),
      jobTitle: data.job_title ?? null,
      name: resolveEmployeeDisplayName(data.full_name, data.nickname),
      status: data.employment_status,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Employee lookup failed.");
    return NextResponse.json(
      { error: isForbiddenError(error) ? "forbidden" : "lookup_error", message },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
