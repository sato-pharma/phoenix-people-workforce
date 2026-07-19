import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertPermission } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_CALLER_ROLES = new Set(["Super Admin"]);

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "read");

    if (!ALLOWED_CALLER_ROLES.has(access.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("app_auth_users")
      .select("hr_id, name, role")
      .eq("is_active", true)
      .not("role", "eq", "Employee")
      .not("role", "eq", "Medical Rep")
      .order("name", { ascending: true });

    if (error) throw error;

    const managers = (data ?? [])
      .filter((u) => u.hr_id && u.name)
      .map((u) => ({ hrId: String(u.hr_id), name: String(u.name) }));

    return NextResponse.json({ managers });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch managers" },
      { status: 500 },
    );
  }
}
