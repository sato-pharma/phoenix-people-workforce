import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { previewTemplate, type EmailTemplatePayload } from "@/lib/email-templates/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as {
      context?: Record<string, string | null>;
      template?: EmailTemplatePayload;
      templateKey?: string;
    };

    if (!body.templateKey) {
      return NextResponse.json({ error: "invalid_template", message: "Template key is required." }, { status: 400 });
    }

    const preview = await previewTemplate(body.templateKey, {
      context: body.context,
      template: body.template,
    });

    return NextResponse.json({ preview });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to preview email templates." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Email template preview failed.");
    return NextResponse.json({ error: "email_template_preview_failed", message }, { status: 500 });
  }
}
