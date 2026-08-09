import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildCodedWorkbook, normalizeUploadedFile } from "@/lib/sales/normalizer/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function slug(value: string | null | undefined) {
  return (value ?? "coded").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "coded";
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden: Source Normalizer is restricted to the admin account." }, { status: 403 });
    }
    await assertPermission(access, "sales", "export");

    const form = await request.formData();
    const file = form.get("file");
    const distributorCode = String(form.get("distributorCode") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ success: false, error: "No file uploaded." }, { status: 400 });
    if (!distributorCode) return NextResponse.json({ success: false, error: "Pick a distributor." }, { status: 400 });

    const normalized = await normalizeUploadedFile(distributorCode, file);
    if (normalized.status !== "ok") {
      return NextResponse.json({ success: false, error: "The sheet could not be normalized — check the distributor selection or sheet format." }, { status: 422 });
    }
    const { result, period } = normalized;
    const buffer = await buildCodedWorkbook(result);
    const fileName = `phoenix-coded-${slug(distributorCode)}-${slug(period)}.xlsx`;

    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    }
    return NextResponse.json({ success: false, error: clientSafeErrorMessage(error, "Failed to build coded sheet.") }, { status: 500 });
  }
}
