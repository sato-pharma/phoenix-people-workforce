import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  createVacationAttachmentReviewUrl,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseAttachmentKind(value: string) {
  return value === "sick" || value === "compensatory" ? value : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; kind: string }> },
) {
  try {
    const { id, kind } = await params;
    const attachmentKind = parseAttachmentKind(kind);
    if (!attachmentKind) {
      return NextResponse.json({ error: "invalid_attachment", message: "Vacation attachment type is invalid.", success: false }, { status: 400 });
    }

    const access = await resolveAccessContext(request);
    const result = await createVacationAttachmentReviewUrl(access, { attachmentKind, requestId: id });

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
