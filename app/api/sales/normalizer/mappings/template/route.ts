import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { buildUnmappedWorkbook, distinctUnknowns } from "@/lib/sales/normalizer/mapping";
import { normalizeUploadedFile } from "@/lib/sales/normalizer/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Build the "unmapped list" XLSX for an uploaded raw file: one row per DISTINCT unknown code, with
// a suggestion + a blank "Phoenix Code" column the user fills, then uploads back to /learn.
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (access.role !== "Super Admin" && access.scope !== "system") {
      return NextResponse.json({ success: false, error: "Forbidden." }, { status: 403 });
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
    const { result, products } = normalized;
    const buffer = await buildUnmappedWorkbook(distinctUnknowns(result.exceptions, products));
    return new Response(new Uint8Array(buffer as ArrayBuffer), {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="phoenix-unmapped-${distributorCode}.xlsx"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Forbidden." }, { status: 403 });
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Failed to build unmapped list." }, { status: 500 });
  }
}
