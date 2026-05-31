import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { validateEmailTemplateDraft, type TemplateRecipientPresetSelection } from "@/lib/email/email-designer";
import type { EmailTemplatePayload } from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ValidateDraftBody = {
  candidateEmail?: string | null;
  employeeHrId?: string | null;
  presets?: TemplateRecipientPresetSelection | null;
  template?: EmailTemplatePayload;
  templateKey?: string;
};

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as ValidateDraftBody;

    if (!body.templateKey || !body.template) {
      return NextResponse.json({ error: "missing_draft", message: "Template key and draft content are required." }, { status: 400 });
    }

    const validation = await validateEmailTemplateDraft({
      candidateEmail: body.candidateEmail,
      employeeHrId: body.employeeHrId,
      presets: body.presets,
      template: body.template,
      templateKey: body.templateKey,
    });

    return NextResponse.json({ validation });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to validate email templates." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Email template draft validation failed.";
    return NextResponse.json({ error: "template_validation_failed", message }, { status: 500 });
  }
}
