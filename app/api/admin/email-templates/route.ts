import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  emailTemplateKeys,
  getEmailTemplateCategoryOptions,
  getEmailTemplateCatalog,
  getEmailTemplateRoutingOptions,
  getTemplatePlaceholderHints,
} from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");

    const [templates, routingOptions] = await Promise.all([
      getEmailTemplateCatalog(),
      getEmailTemplateRoutingOptions(),
    ]);

    return NextResponse.json({
      placeholderHints: getTemplatePlaceholderHints(),
      templateCategories: getEmailTemplateCategoryOptions(),
      templateKeys: emailTemplateKeys,
      templates,
      routingOptions,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to email templates." },
        { status: 403 },
      );
    }

    const message = error instanceof Error ? error.message : "Email templates failed to load.";
    return NextResponse.json({ error: "email_templates_failed", message }, { status: 500 });
  }
}
