import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { simulateTemplateRecipients, type EmailTemplatePayload } from "@/lib/email-templates/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const body = (await request.json().catch(() => ({}))) as {
      candidateEmail?: string | null;
      employeeHrId?: string | null;
      template?: EmailTemplatePayload;
      templateKey?: string;
    };

    if (!body.templateKey) {
      return NextResponse.json({ error: "invalid_template", message: "Template key is required." }, { status: 400 });
    }

    const simulation = await simulateTemplateRecipients({
      candidateEmail: body.candidateEmail,
      context: { employeeHrId: body.employeeHrId },
      template: body.template,
      templateKey: body.templateKey,
    });

    return NextResponse.json({ simulation });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to simulate email recipients." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Recipient simulation failed.");
    return NextResponse.json({ error: "recipient_simulation_failed", message }, { status: 500 });
  }
}
