import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { refusePrivilegedTemplateChange } from "@/lib/email-templates/privileged-fields";
import {
  EmailTemplateValidationError,
  getEmailTemplate,
  saveEmailTemplate,
  type EmailTemplatePayload,
} from "@/lib/email-templates/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ templateKey: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const { templateKey } = await context.params;
    const template = await getEmailTemplate(templateKey);
    if (!template) {
      return NextResponse.json({ error: "not_found", message: "Email template not found." }, { status: 404 });
    }
    return NextResponse.json({ template });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email templates." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Email template failed to load.");
    return NextResponse.json({ error: "email_template_failed", message }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    const { templateKey } = await context.params;
    const body = (await request.json().catch(() => ({}))) as EmailTemplatePayload & {
      action?: "draft" | "publish" | "save";
      changeReason?: string;
    };
    // WHERE THE MAIL GOES IS A DIFFERENT PRIVILEGE FROM WHAT IT SAYS. `communication: update` used
    // to mean Super Admin and now also means the HR Business Partner, so the fields that add a
    // permanent recipient to every send - and the switch that stops a template sending at all -
    // need their own check. It compares against the STORED row rather than refusing any payload
    // that mentions them, because the designer posts the whole rules object on an ordinary content
    // save. See src/lib/email-templates/privileged-fields.ts for what each field does.
    const stored = await getEmailTemplate(templateKey);
    const refusal = refusePrivilegedTemplateChange({ payload: body, role: access.role, stored });
    if (refusal) {
      return NextResponse.json({ error: "forbidden", message: refusal }, { status: 403 });
    }
    const template = await saveEmailTemplate(templateKey, body, access.loginId ?? access.hrId, {
      action: body.action ?? (body.isActive ? "publish" : "draft"),
      reason: body.changeReason,
    });
    return NextResponse.json({ template });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to update email templates." }, { status: 403 });
    }
    if (error instanceof EmailTemplateValidationError) {
      return NextResponse.json(
        { error: "validation_failed", issues: error.issues, message: "Fix the highlighted template issues before saving." },
        { status: 400 },
      );
    }
    const message = clientSafeErrorMessage(error, "Email template update failed.");
    return NextResponse.json({ error: "email_template_update_failed", message }, { status: 500 });
  }
}
