import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { resolveComposerRecipients, type ComposerPayload } from "@/lib/email/email-composer-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as ComposerPayload;
    const recipients = await resolveComposerRecipients(body);

    return NextResponse.json({ recipients });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to resolve email recipients." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Email recipient resolution failed.";
    return NextResponse.json({ error: "recipient_resolution_failed", message }, { status: 500 });
  }
}
