import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listEmailTemplates } from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "admin", "read");
    const templates = await listEmailTemplates();
    return NextResponse.json({ templates });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email templates." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Failed to load email templates.";
    return NextResponse.json({ error: "load_failed", message }, { status: 500 });
  }
}
