import { NextResponse } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { canAccess } from "@/lib/auth/permissions";
import { getSalaryFlags, resolveSalaryFlag } from "@/lib/admin/service";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!await canAccess(access, "admin", "read")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }
    const url = new URL(request.url);
    const showResolved = url.searchParams.get("showResolved") === "true";
    const result = await getSalaryFlags(showResolved);
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load salary flags." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!await canAccess(access, "admin", "update")) {
      return NextResponse.json({ message: "Forbidden: insufficient permissions." }, { status: 403 });
    }

    const body = await request.json() as { id?: string };
    if (!body.id) {
      return NextResponse.json({ message: "Missing flag id." }, { status: 400 });
    }

    const resolvedBy = access.loginId ?? "system";

    const supabase = getSupabaseAdmin();
    const flagResult = await supabase
      .from("salary_flags")
      .select("id")
      .eq("id", body.id)
      .maybeSingle();
    if (flagResult.error) throw flagResult.error;
    if (!flagResult.data) {
      return NextResponse.json({ message: "Salary flag not found." }, { status: 404 });
    }

    await resolveSalaryFlag(body.id, resolvedBy);

    await writeAuditLog({
      actorLoginId: access.loginId,
      entityId: String(body.id),
      entityType: "salary_flag",
      summary: `Salary flag #${body.id} resolved by ${resolvedBy}`,
    }).catch(() => undefined);

    const updated = await getSalaryFlags(false);
    return NextResponse.json(updated);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to resolve salary flag." },
      { status: 500 },
    );
  }
}
