import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { refusePrivilegedTemplateChange } from "@/lib/email-templates/privileged-fields";
import {
  EmailTemplateValidationError,
  getEmailTemplate,
  getEmailTemplateHistory,
  rollbackEmailTemplate,
} from "@/lib/email-templates/service";
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

    // 🔴 ROLLBACK IS A WRITE TO THE SAME PRIVILEGED FIELDS, BY ANOTHER NAME.
    //
    // `rollbackEmailTemplate` calls saveEmailTemplate with `rules: selected.rulesSnapshot` and
    // spreads `selected.templateSnapshot`, which carries `isActive`. So restoring an old version
    // restores that version's fixed To/Cc/Bcc addresses and its on/off state — the two things the
    // save route refuses to let anyone but a Super Admin change.
    //
    // Without this check the fence on the save route is decorative: a holder of `communication:
    // update` who cannot ADD a Bcc could still reinstate one that any earlier version carried, and
    // could switch a template off by rolling back to a version where it was off. Neither shows up
    // as a recipient edit — it is filed as a rollback, with a reason, and looks like housekeeping.
    //
    // Same guard, same stored row, same comparison as the save route, so the two cannot drift.
    const history = await getEmailTemplateHistory(templateKey);
    const target = history.find((entry) => entry.versionNumber === Number(body.versionNumber));
    if (target) {
      const stored = await getEmailTemplate(templateKey);
      const refusal = refusePrivilegedTemplateChange({
        payload: { isActive: target.templateSnapshot.isActive, rules: target.rulesSnapshot },
        role: access.role,
        stored,
      });
      if (refusal) {
        return NextResponse.json({ error: "forbidden", message: refusal }, { status: 403 });
      }
    }
    // A version that does not exist is left to the service, which already throws for it — so a bad
    // version number keeps answering exactly as it did before this guard was added.

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
