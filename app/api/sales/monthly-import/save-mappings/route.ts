import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { saveMappings, type MappingInput } from "@/lib/sales/normalizer/mapping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Persist the unknowns the user confirmed on the Missing/AI panel. Each mapping is validated against
// the masters inside saveMappings (product code / brick id), then upserted into the alias tables.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { mappings?: MappingInput[] };
    const mappings = (Array.isArray(body.mappings) ? body.mappings : []).filter(
      (m) => m && m.raw && m.code && (m.type === "product" || m.type === "territory" || m.type === "customer"),
    );
    if (mappings.length === 0) {
      return NextResponse.json({ success: false, error: "No mappings to save." }, { status: 400 });
    }

    const result = await saveMappings(mappings);
    return NextResponse.json({
      success: true,
      result,
      message: `${result.saved} mappings saved (${result.skipped} skipped, ${result.invalid} invalid).`,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save mappings." },
      { status: 500 },
    );
  }
}
