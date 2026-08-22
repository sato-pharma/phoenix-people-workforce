import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  getHiringDocumentFileForDownload,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
  removeHiringDocumentFile,
} from "@/lib/hiring-documents/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown) {
  if (isForbiddenError(error)) return { message: hiringDocumentsErrorMessage(error), status: 403 };
  if (isHiringDocumentsSchemaMissing(error)) {
    return {
      message:
        "Document capture is not ready yet. The Supabase migration that creates the hiring-documents store has not been applied.",
      status: 409,
    };
  }
  return { message: hiringDocumentsErrorMessage(error), status: 500 };
}

/**
 * Build a Content-Disposition that survives an Arabic file name.
 *
 * The plain `filename=` parameter is latin-1 only, so a certificate named in Arabic either throws
 * when the header is set or arrives as mojibake. RFC 5987's `filename*` carries the real name and
 * every current browser prefers it; the ASCII `filename` stays as the fallback.
 */
function contentDisposition(disposition: "inline" | "attachment", fileName: string) {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "document";
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Stream one stored document.
 *
 * Streaming through the route rather than handing out a signed URL is deliberate: a signed URL to a
 * birth certificate is a working, shareable link that outlives the page it was opened from and
 * lands in browser history. Here, every read passes `assertPermission` and the per-employee
 * visibility check, and the storage path is resolved server-side from the id.
 *
 * `?download=1` forces a save instead of an in-page preview. The default is inline, because the
 * common action is "look at the scan HR just filed", not "put another copy on this laptop".
 */
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const { fileId } = await params;
    const file = await getHiringDocumentFileForDownload(access, fileId);
    if (!file) {
      return NextResponse.json({ error: "not_found", message: "That file is no longer on record." }, { status: 404 });
    }

    const wantsDownload = new URL(request.url).searchParams.get("download") === "1";
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Disposition": contentDisposition(wantsDownload ? "attachment" : "inline", file.fileName),
        "Content-Length": String(file.bytes.length),
        "Content-Type": file.contentType,
        // Personnel documents must not sit in a shared or disk cache. `private` alone still allows
        // the browser's own store; `no-store` is what keeps a national ID out of it.
        "Cache-Control": "no-store, private",
      },
    });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_file_read_failed", message }, { status });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");

    const { fileId } = await params;
    const result = await removeHiringDocumentFile(access, fileId);
    return NextResponse.json(result);
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_file_delete_failed", message }, { status });
  }
}
