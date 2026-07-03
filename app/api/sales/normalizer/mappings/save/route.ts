import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: mapping is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { mappings?: MappingInput[]; backfill?: boolean };
    const mappings = Array.isArray(body.mappings) ? body.mappings.filter((m) => m && (m.type === "product" || m.type === "territory" || m.type === "customer") && m.raw && m.code) : [];
    if (mappings.length === 0) return NextResponse.json({ success: false, error: "No mappings to save." }, { status: 400 });

    const result = await saveMappings(mappings, {
      backfill: body.backfill === true,
      mappedBy: access.loginId ?? undefined,
    });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : (() => { try { return JSON.stringify(error); } catch { return ""; } })();
    return NextResponse.json({ success: false, error: message || "Failed to save mappings." }, { status: 500 });
  }
}
