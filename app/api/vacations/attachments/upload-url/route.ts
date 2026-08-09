import crypto from "node:crypto";

import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { sanitizeStorageSegment, vacationAttachmentBucket } from "@/lib/vacation/service";
import { assertVacationRouteRateLimit } from "@/lib/vacation/route-guards";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sick documents and compensatory-day event photos routinely exceed Vercel's ~4.5MB serverless
// request-body cap (a phone camera JPEG alone is often 5-9MB). For large files the browser mints a
// short-lived signed upload URL here and streams the bytes straight to the "leave-attachments"
// bucket (no function body involved), then calls /api/vacations/requests with the resulting storage
// path instead of the raw file. Permission-gated identically to the submit route, so only users who
// may create a leave request can reserve an upload slot. See attachment-transport.ts for the
// download-and-cleanup side of this.
const ATTACHMENT_KINDS = new Set(["sick", "compensatory"]);

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "leave", "create");
    await assertVacationRouteRateLimit({
      actor: access.loginId ?? access.hrId,
      limit: 12,
      request,
      scope: "vacation:upload-url",
      windowMs: 60_000,
    });

    const body = (await request.json().catch(() => ({}))) as { fileName?: string; kind?: string };
    const kind = ATTACHMENT_KINDS.has(String(body?.kind ?? "")) ? String(body.kind) : null;
    if (!kind) {
      return NextResponse.json(
        { error: "invalid_attachment_kind", message: "Attachment kind must be sick or compensatory.", success: false },
        { status: 400 },
      );
    }
    const employeeHrId = sanitizeStorageSegment(access.hrId, "unknown-employee");
    const fileName = sanitizeStorageSegment(body?.fileName, kind === "sick" ? "sick-document" : "compensatory-event-photo");
    // Random per-upload id so concurrent uploads never collide; the pending object is downloaded into
    // its final canonical path and deleted as soon as the request is created (or on failure).
    const path = `pending/${kind}/${employeeHrId}/${crypto.randomUUID()}/${fileName}`;

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(vacationAttachmentBucket).createSignedUploadUrl(path);
    if (error || !data) {
      return NextResponse.json(
        { error: "upload_url_failed", message: error?.message ?? "Could not create an upload URL.", success: false },
        { status: 500 },
      );
    }

    return NextResponse.json({ bucket: vacationAttachmentBucket, path, signedUrl: data.signedUrl, success: true, token: data.token });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), success: false },
        { status: 403 },
      );
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many upload attempts. Please wait a moment and try again.", success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json(
      { error: "upload_url_failed", message: clientSafeErrorMessage(error, "Could not create an upload URL."), success: false },
      { status: 500 },
    );
  }
}
