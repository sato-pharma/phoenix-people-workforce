import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { detectDistributorFromBuffer } from "@/lib/sales/distributor-detection";
import { SALES_IMPORT_BUCKET } from "@/lib/sales/monthly-import-request";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: parse just the header row of the uploaded sheet and return the best-matching
// distributor(s). Used so the upload screen can pre-select the right distributor (and warn on a
// wrong manual pick). Persists nothing. Detection logic is shared via distributor-detection.ts.

async function resolveBuffer(request: Request): Promise<{ buffer: ArrayBuffer } | { error: string; status: number }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as { storagePath?: string };
    const path = String(body?.storagePath ?? "").trim();
    if (!path) return { error: "Uploaded file reference is missing.", status: 400 };
    const { data, error } = await getSupabaseAdmin().storage.from(SALES_IMPORT_BUCKET).download(path);
    if (error || !data) return { error: "Uploaded workbook was not found in storage.", status: 400 };
    return { buffer: await data.arrayBuffer() };
  }
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) return { error: "Sales workbook file is required.", status: 400 };
  return { buffer: await file.arrayBuffer() };
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const resolved = await resolveBuffer(request);
    if ("error" in resolved) {
      return NextResponse.json({ error: resolved.error, success: false }, { status: resolved.status });
    }

    const detection = await detectDistributorFromBuffer(resolved.buffer);
    return NextResponse.json({ data: detection, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Forbidden.", success: false }, { status: 403 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Distributor detection failed.", success: false }, { status: 500 });
  }
}
