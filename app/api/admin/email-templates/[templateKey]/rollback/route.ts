import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { EmailTemplateValidationError, rollbackEmailTemplate } from "@/lib/email-templates/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ templateKey: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    const { templateKey } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      changeReason?: string;
      versionNumber?: number;
    };

    if (!Number.isInteger(body.versionNumber) || Number(body.versionNumber) <= 0) {
      return NextResponse.json({ error: "invalid_version", message: "A valid history version is required." }, { status: 400 });
    }

    const template = await rollbackEmailTemplate({
      actor: access.loginId ?? access.hrId,
      reason: body.changeReason,
      templateKey,
      versionNumber: Number(body.versionNumber),
    });

    return NextResponse.json({ template });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to roll back email templates." }, { status: 403 });
    }
    if (error instanceof EmailTemplateValidationError) {
      return NextResponse.json(
        { error: "validation_failed", issues: error.issues, message: "Fix the rollback reason before continuing." },
        { status: 400 },
      );
    }
    const message = clientSafeErrorMessage(error, "Email template rollback failed.");
    return NextResponse.json({ error: "email_template_rollback_failed", message }, { status: 500 });
  }
}
