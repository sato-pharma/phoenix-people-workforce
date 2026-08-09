import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { removeSalesUploadObject } from "@/lib/sales/monthly-import-request";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cancel a preview without importing: deletes the large-file Storage object the browser uploaded so it
// doesn't linger in the `sales-imports` bucket. Small files (no storagePath) are a no-op. Nothing is
// ever persisted here.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as { storagePath?: string };
    const storagePath = String(body?.storagePath ?? "").trim();
    await removeSalesUploadObject(storagePath || null);
    return NextResponse.json({ message: "Preview discarded.", success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden."), success: false }, { status: 403 });
    }
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Cancel failed."), success: false }, { status: 500 });
  }
}
