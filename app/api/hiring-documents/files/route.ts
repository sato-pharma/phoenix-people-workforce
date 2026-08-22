import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isHiringDocumentScanMode } from "@/lib/hiring-documents/document-scan";
import {
  attachHiringDocumentFiles,
  hiringDocumentsErrorMessage,
  isHiringDocumentsSchemaMissing,
  listHiringDocumentFiles,
} from "@/lib/hiring-documents/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { HiringDocumentFileSource } from "@/lib/hiring-documents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Polishing four 12-megapixel photographs through sharp, assembling them into a PDF and pushing
 * that to Frankfurt is the slowest thing this module does — comfortably past the default handler
 * timeout on a cold container. A scan that dies halfway leaves HR re-photographing a certificate
 * they already photographed.
 */
export const maxDuration = 60;

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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "read");

    const url = new URL(request.url);
    const employeeHrId = url.searchParams.get("employeeHrId") ?? "";
    const documentId = url.searchParams.get("documentId") ?? "";

    const files = await listHiringDocumentFiles(access, { documentId, employeeHrId });
    return NextResponse.json({ files });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_files_load_failed", message }, { status });
  }
}

/**
 * Attach one or more files to a hiring document.
 *
 * Multipart rather than JSON base64: a 12-megapixel photograph grows by a third when base64-encoded,
 * and HR captures these on a phone over Egyptian mobile data. The fields are `employeeHrId`,
 * `documentId`, `mode` (`upload` or `scan`), an optional `scanMode`, and a repeatable `file`.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employee_documents", "update");

    const formData = await request.formData();
    const employeeHrId = String(formData.get("employeeHrId") ?? "");
    const documentId = String(formData.get("documentId") ?? "");
    const rawMode = String(formData.get("mode") ?? "upload");
    const mode: HiringDocumentFileSource = rawMode === "scan" ? "scan" : "upload";
    const rawScanMode = formData.get("scanMode");
    const scanMode = isHiringDocumentScanMode(rawScanMode) ? rawScanMode : undefined;

    const uploads = formData.getAll("file").filter((entry): entry is File => entry instanceof File);
    if (uploads.length === 0) {
      return NextResponse.json(
        { error: "no_file", message: "Choose at least one file or photograph to attach." },
        { status: 400 },
      );
    }

    const pages = await Promise.all(
      uploads.map(async (file) => ({
        bytes: Buffer.from(await file.arrayBuffer()),
        // A browser leaves `type` empty for a file it cannot classify. Naming it here produces a
        // clear "must be a PDF, JPG, PNG or WEBP" instead of a storage-layer complaint about an
        // empty MIME type.
        contentType: file.type || "application/octet-stream",
        fileName: file.name || "document",
      })),
    );

    const files = await attachHiringDocumentFiles(access, {
      documentId,
      employeeHrId,
      mode,
      pages,
      scanMode,
      uploadedByHrId: access.hrId ?? null,
    });

    return NextResponse.json({ files }, { status: 201 });
  } catch (error) {
    const { message, status } = apiError(error);
    return NextResponse.json({ error: "hiring_document_file_upload_failed", message }, { status });
  }
}
