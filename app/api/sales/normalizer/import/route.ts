import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { normalizeUploadedFile, persistNormalizedBatch } from "@/lib/sales/normalizer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "import");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const { result, distributorName } = await normalizeUploadedFile(distributorCode, file);
    if (result.coded.length === 0) {
      return NextResponse.json({ success: false, error: "Nothing to import — no rows could be coded. Map the exceptions first." }, { status: 400 });
    }
    const persisted = await persistNormalizedBatch({
      distributorCode,
      distributorName,
      fileName: file.name,
      result,
      uploadedBy: access.loginId ?? access.hrId ?? "admin",
    });
    return NextResponse.json({ success: true, data: { ...persisted, exceptions: result.exceptions.length } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to import." }, { status: 500 });
  }
}
