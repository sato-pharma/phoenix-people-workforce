import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Large distributor workbooks (> ~4MB) can't be POSTed through the serverless function — Vercel caps the
// request body at ~4.5MB (FUNCTION_PAYLOAD_TOO_LARGE). Instead the browser asks here for a short-lived
// signed upload URL into the private "sales-imports" bucket, uploads the file straight to Storage (no
// function involved), then calls /validate with the returned storagePath. Permission-gated identically
// to the validate route, so only users who may import sales can mint an upload URL.
const BUCKET = "sales-imports";

function sanitizeFileName(name: string): string {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safe = cleaned || "upload.xlsx";
  return /\.(xlsx|xls)$/i.test(safe) ? safe : `${safe}.xlsx`;
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "sales", "import");

    const body = (await request.json().catch(() => ({}))) as { fileName?: string };
    const fileName = sanitizeFileName(body?.fileName ?? "upload.xlsx");
    // Random per-upload prefix so concurrent uploads never collide; the file is deleted after validation.
    const path = `incoming/${crypto.randomUUID()}/${fileName}`;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json(
        { success: false, error: error?.message ?? "Could not create an upload URL." },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, bucket: BUCKET, path, token: data.token, signedUrl: data.signedUrl });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { success: false, error: error instanceof Error ? error.message : "Forbidden." },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Could not create an upload URL." },
      { status: 500 },
    );
  }
}
