import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { emailSignatureUrl, previewManualEmail, type ComposerPayload } from "@/lib/email/email-composer-service";
import { canSendReplyComposerToLists, isReplyBulkPayload, previewReplyBulk } from "@/lib/email/email-reply-lists";
import { systemEmail } from "@/config/system-settings";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as ComposerPayload;
    if (isReplyBulkPayload(body)) {
      if (!canSendReplyComposerToLists(access)) {
        return NextResponse.json(
          { error: "forbidden", message: "Only the system administrator can send to distribution lists." },
          { status: 403 },
        );
      }
      const preview = await previewReplyBulk(body, emailSignatureUrl(request.url), systemEmail.seatReplyTo[access.role]);
      return NextResponse.json({ preview });
    }
    const preview = await previewManualEmail(body, request.url);

    return NextResponse.json({ preview });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to preview HR emails." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Email preview failed.");
    return NextResponse.json({ error: "composer_preview_failed", message }, { status: 500 });
  }
}
