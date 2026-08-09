import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  EmailTemplateValidationError,
  sendTemplateTestEmail,
  type EmailTemplatePayload,
} from "@/lib/email-templates/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    const body = (await request.json().catch(() => ({}))) as {
      template?: EmailTemplatePayload;
      templateKey?: string;
      to?: string;
    };

    if (!body.templateKey) {
      return NextResponse.json({ error: "invalid_template", message: "Template key is required." }, { status: 400 });
    }

    const result = await sendTemplateTestEmail({
      template: body.template,
      templateKey: body.templateKey,
      to: body.to ?? "",
    });

    return NextResponse.json({ result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to send test emails." }, { status: 403 });
    }
    if (error instanceof EmailTemplateValidationError) {
      return NextResponse.json(
        { error: "validation_failed", issues: error.issues, message: "Fix the highlighted template issues before sending a test." },
        { status: 400 },
      );
    }
    const message = clientSafeErrorMessage(error, "Test email failed.");
    return NextResponse.json({ error: "email_template_test_failed", message }, { status: 500 });
  }
}
