import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  isOwnPendingVacationAttachmentPath,
  removePendingVacationAttachment,
  resolvePendingVacationAttachment,
} from "@/lib/vacation/attachment-transport";
import {
  addVacationRequestAttachments,
  isVacationSchemaMissing,
  vacationErrorMessage,
  type VacationAttachmentUpload,
} from "@/lib/vacation/service";
import { assertVacationRouteRateLimit } from "@/lib/vacation/route-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Add documents to a request that is ALREADY SUBMITTED. Owner, 2026-10-03: a later upload is an
// ADD-ON to what the employee sent before and never a replacement, so this route only ever inserts —
// see addVacationRequestAttachments, which is where that rule is enforced.
//
// Every file arrives as a PENDING STORAGE PATH, never as bytes in this body: the browser mints a
// short-lived signed upload URL (/api/vacations/attachments/upload-url) and streams each file
// straight to the "leave-attachments" bucket. That is what keeps a 9MB phone photo — or five of
// them — from meeting the ~4.5MB serverless body cap, and it is the same transport the submit route
// already uses for a large file.

const maxFilesPerCall = 10;

type IncomingFile = { contentType?: unknown; fileName?: unknown; path?: unknown };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Whatever happens below, a pending object must not be left behind: it is deleted once its bytes
  // have been copied into the request's own folder, and also when the call fails.
  const pendingPaths: string[] = [];
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    // Asserted again inside addVacationRequestAttachments, but a referenced upload is downloaded
    // before that call, so a caller who may not file leave is turned away before any storage read.
    await assertPermission(access, "leave", "create");
    await assertVacationRouteRateLimit({
      actor: access.loginId ?? access.hrId,
      limit: 12,
      request,
      scope: "vacation:attachment-add",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as { files?: unknown };
    const incoming = Array.isArray(body?.files) ? (body.files as IncomingFile[]) : [];
    if (incoming.length === 0) {
      return NextResponse.json(
        { error: "no_files", message: "Choose at least one file to upload.", success: false },
        { status: 400 },
      );
    }
    if (incoming.length > maxFilesPerCall) {
      return NextResponse.json(
        {
          error: "too_many_files",
          message: `Upload up to ${maxFilesPerCall} files at a time.`,
          success: false,
        },
        { status: 400 },
      );
    }

    // A storage path may only name the CALLER'S OWN pending upload slot, exactly as the upload-url
    // route minted it. Checked for every file before any of them is read, because the service-role
    // client copies the object and then deletes it: an unchecked path let a signed-in employee lift,
    // and then erase, another employee's filed medical document.
    const paths = incoming.map((file) => String(file?.path ?? "").trim());
    if (
      paths.some(
        (path) =>
          !path ||
          (!isOwnPendingVacationAttachmentPath({ hrId: access.hrId, kind: "sick", storagePath: path }) &&
            !isOwnPendingVacationAttachmentPath({ hrId: access.hrId, kind: "compensatory", storagePath: path })),
      )
    ) {
      return NextResponse.json(
        {
          error: "invalid_attachment_path",
          message: "One of the files does not match your upload. Please attach the files again.",
          success: false,
        },
        { status: 400 },
      );
    }

    const attachments: VacationAttachmentUpload[] = [];
    for (const [index, path] of paths.entries()) {
      pendingPaths.push(path);
      attachments.push(
        await resolvePendingVacationAttachment(path, {
          contentType: String(incoming[index]?.contentType ?? "").trim(),
          fileName: String(incoming[index]?.fileName ?? "").trim(),
        }),
      );
    }

    const result = await addVacationRequestAttachments(access, { attachments, requestId: id });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to add documents to this request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json(
      { error: "vacation_attachment_add_failed", message: clientSafeErrorMessage(error, message), success: false },
      { status: 400 },
    );
  } finally {
    await Promise.all(pendingPaths.map((path) => removePendingVacationAttachment(path)));
  }
}
