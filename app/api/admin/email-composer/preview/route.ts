import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { previewManualEmail, type ComposerPayload } from "@/lib/email/email-composer-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as ComposerPayload;
    const preview = await previewManualEmail(body, request.url);

    return NextResponse.json({ preview });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to preview HR emails." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Email preview failed.";
    return NextResponse.json({ error: "composer_preview_failed", message }, { status: 500 });
  }
}
