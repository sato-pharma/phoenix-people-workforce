import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmailDesignerMetadata } from "@/lib/email/email-designer";
import { getEmailTemplateCatalog, getEmailTemplateRoutingOptions } from "@/lib/email-templates/service";

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
      ...getEmailDesignerMetadata(),
      routingOptions,
      templates: templates.map((template) => ({
        description: template.description,
        isActive: template.isActive,
        templateKey: template.templateKey,
        templateName: template.templateName,
        updatedAt: template.updatedAt,
      })),
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to email template designer metadata." }, { status: 403 });
    }
    const message = error instanceof Error ? error.message : "Email template designer metadata failed to load.";
    return NextResponse.json({ error: "designer_metadata_failed", message }, { status: 500 });
  }
}
