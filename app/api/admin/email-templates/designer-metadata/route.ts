import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmailDesignerMetadata } from "@/lib/email/email-designer";
import { EMPLOYEE_VARIABLE_SOURCES, listEmailCustomVariables } from "@/lib/email-templates/custom-variables";
import { emailTemplateKeys, getEmailTemplateCategoryOptions, getEmailTemplateDesignerCatalog, getEmailTemplateRoutingOptions } from "@/lib/email-templates/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "communication", "read");
    const [templates, routingOptions, customVariables] = await Promise.all([
      getEmailTemplateDesignerCatalog(),
      getEmailTemplateRoutingOptions(),
      listEmailCustomVariables(),
    ]);

    const sampleByColumn = new Map(EMPLOYEE_VARIABLE_SOURCES.map((source) => [source.column, source.sample]));
    const baseMetadata = getEmailDesignerMetadata();

    return NextResponse.json({
      ...baseMetadata,
      categories: getEmailTemplateCategoryOptions(),
      customVariables,
      routingOptions,
      // Admin-defined custom variables appear as chips alongside the built-ins. Invalid rows
      // (source_column fell off the allowlist after being saved, e.g. via a future allowlist
      // narrowing) are excluded here — still visible in the dedicated manager as "invalid".
      variables: [
        ...baseMetadata.variables,
        ...customVariables
          .filter((variable) => variable.sourceAllowed)
          .map((variable) => ({
            allowedTemplateTypes: [...emailTemplateKeys],
            category: "Company" as const,
            label: variable.label,
            sampleValue: sampleByColumn.get(variable.sourceColumn) ?? "(custom field)",
            token: variable.token,
          })),
      ],
      templates: templates.map((template) => ({
        category: template.category,
        description: template.description,
        hasDraftChanges: template.hasDraftChanges,
        health: template.health,
        isActive: template.isActive,
        publicationState: template.publicationState,
        publishedIsActive: template.publishedIsActive,
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
