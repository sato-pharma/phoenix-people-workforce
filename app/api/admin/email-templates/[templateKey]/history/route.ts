import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmailTemplateHistory } from "@/lib/email-templates/service";

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
    const history = await getEmailTemplateHistory(templateKey);
    return NextResponse.json({ history });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email template history." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Email template history failed to load.";
    return NextResponse.json({ error: "email_template_history_failed", message }, { status: 500 });
  }
}
