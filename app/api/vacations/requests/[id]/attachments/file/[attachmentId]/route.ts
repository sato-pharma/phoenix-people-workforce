import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createVacationAttachmentFileReviewUrl,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Open ONE file of a request's attachment history by its row id.
//
// The sibling `/attachments/<kind>` route signs the FIRST file only — it reads the legacy
// single-attachment columns — so a sick request carrying several documents needs this route to open
// the second and the third. The literal `file` segment sits one level deeper than that `[kind]`
// route, so the two can never be confused for one another.

export async function GET(
  request: Request,
  { params }: { params: Promise<{ attachmentId: string; id: string }> },
) {
  try {
    const { attachmentId, id } = await params;
    const access = await resolveAccessContext(request);
    const result = await createVacationAttachmentFileReviewUrl(access, { attachmentId, requestId: id });

    return NextResponse.redirect(result.signedUrl, 303);
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to open vacation attachment.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    return NextResponse.json({ error: "vacation_attachment_failed", message, success: false }, { status: 400 });
  }
}
