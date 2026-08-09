import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmailComposerOptions, searchComposerEmployees } from "@/lib/email/email-composer-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    const options = await getEmailComposerOptions();
    const employeeOptions = query.trim() ? await searchComposerEmployees(query) : options.employeeOptions;

    return NextResponse.json({ options: { ...options, employeeOptions } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email composer options." }, { status: 403 });
    }
    const message = clientSafeErrorMessage(error, "Email composer options failed to load.");
    return NextResponse.json({ error: "composer_options_failed", message }, { status: 500 });
  }
}
