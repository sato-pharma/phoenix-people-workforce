import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { learnFromUploadedMappings } from "@/lib/sales/normalizer/mapping";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Accept the filled "unmapped list" XLSX (Phoenix Code column completed) and learn every mapping.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: mapping is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    const distributorCode = String(form.get("distributorCode") ?? "") || undefined;

    const result = await learnFromUploadedMappings(await file.arrayBuffer(), distributorCode);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to learn mappings.") }, { status: 500 });
  }
}
