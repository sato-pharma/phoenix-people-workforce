import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { CustomVariableError, deleteEmailCustomVariable } from "@/lib/email-templates/custom-variables";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ token: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    const { token } = await context.params;
    await deleteEmailCustomVariable(token);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to manage email template variables." }, { status: 403 });
    }
    if (error instanceof CustomVariableError) {
      return NextResponse.json({ error: "validation_failed", message: error.message }, { status: 400 });
    }
    const message = clientSafeErrorMessage(error, "Custom variable delete failed.");
    return NextResponse.json({ error: "custom_variable_delete_failed", message }, { status: 500 });
  }
}
