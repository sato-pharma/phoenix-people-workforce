import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { removeSalesUploadObject } from "@/lib/sales/monthly-import-request";
import { isOwnSalesImportUploadPath, SALES_UPLOAD_PATH_REFUSAL } from "@/lib/sales/sales-import-upload-path";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cancel a preview without importing: deletes the large-file Storage object the browser uploaded so it
// doesn't linger in the `sales-imports` bucket. Small files (no storagePath) are a no-op. Nothing is
// ever persisted here. The delete runs with the service-role client, so only the caller's OWN upload
// slot may be named; anything else is refused before any storage call.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");
    const body = (await request.json().catch(() => ({}))) as { storagePath?: string };
    const storagePath = String(body?.storagePath ?? "").trim();
    if (storagePath && !isOwnSalesImportUploadPath({ caller: access, storagePath })) {
      return NextResponse.json({ ...SALES_UPLOAD_PATH_REFUSAL, success: false }, { status: 400 });
    }
    await removeSalesUploadObject(storagePath || null);
    return NextResponse.json({ message: "Preview discarded.", success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden."), success: false }, { status: 403 });
    }
    return NextResponse.json({ error: clientSafeErrorMessage(error, "Cancel failed."), success: false }, { status: 500 });
  }
}
