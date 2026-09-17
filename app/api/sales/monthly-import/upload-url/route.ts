import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { SALES_IMPORT_BUCKET } from "@/lib/sales/monthly-import-request";
import { buildSalesImportUploadPath } from "@/lib/sales/sales-import-upload-path";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Large distributor workbooks (> ~4MB) can't be POSTed through the serverless function — Vercel caps the
// request body at ~4.5MB (FUNCTION_PAYLOAD_TOO_LARGE). Instead the browser asks here for a short-lived
// signed upload URL into the private "sales-imports" bucket, uploads the file straight to Storage (no
// function involved), then calls /validate with the returned storagePath. Permission-gated identically
// to the validate route, so only users who may import sales can mint an upload URL. The path names its
// caller (sales-import-upload-path.ts), and every route that takes a path back refuses one minted for
// anybody else.

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { fileName?: string };
    // Random per-upload id so concurrent uploads never collide; the file is deleted after validation.
    const path = buildSalesImportUploadPath({ caller: access, fileName: body?.fileName, uploadId: crypto.randomUUID() });
    if (!path) {
      return NextResponse.json(
        { success: false, error: "This account has no identity to hold an upload. Sign in again and retry." },
        { status: 403 },
      );
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(SALES_IMPORT_BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json(
        { success: false, error: error?.message ?? "Could not create an upload URL." },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, bucket: SALES_IMPORT_BUCKET, path, token: data.token, signedUrl: data.signedUrl });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: clientSafeErrorMessage(error, "Could not create an upload URL.") },
      { status: 500 },
    );
  }
}
