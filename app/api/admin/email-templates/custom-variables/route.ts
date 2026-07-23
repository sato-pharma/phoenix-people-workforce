import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  CustomVariableError,
  EMPLOYEE_VARIABLE_SOURCES,
  listEmailCustomVariables,
  saveEmailCustomVariable,
} from "@/lib/email-templates/custom-variables";
import { getTemplatePlaceholderHints } from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const [variables] = await Promise.all([listEmailCustomVariables()]);
    return NextResponse.json({ availableSources: EMPLOYEE_VARIABLE_SOURCES, variables });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email template variables." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Custom variables failed to load.";
    return NextResponse.json({ error: "custom_variables_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "update");
    const body = (await request.json().catch(() => ({}))) as {
      description?: string;
      label?: string;
      sourceColumn?: string;
      token?: string;
    };

    const reservedTokens = new Set(getTemplatePlaceholderHints());
    const variable = await saveEmailCustomVariable(
      {
        description: body.description,
        label: String(body.label ?? "").slice(0, 100),
        sourceColumn: String(body.sourceColumn ?? ""),
        token: String(body.token ?? "").slice(0, 40),
      },
      access.hrId || access.loginId,
      reservedTokens,
    );
    return NextResponse.json({ variable });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to manage email template variables." }, { status: 403 });
    }
    if (error instanceof CustomVariableError) {
      return NextResponse.json({ error: "validation_failed", message: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Custom variable save failed.";
    return NextResponse.json({ error: "custom_variable_save_failed", message }, { status: 500 });
  }
}
