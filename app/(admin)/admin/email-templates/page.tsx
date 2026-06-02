import { redirect } from "next/navigation";

import { EmailTemplateManager } from "@/components/admin/email-template-manager";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmailTemplateDesignerCatalog,
  getEmailTemplateReadinessMetrics,
  getEmailTemplateRoutingOptions,
  getTemplatePlaceholderHints,
} from "@/lib/email-templates/service";

export const dynamic = "force-dynamic";

export default async function AdminEmailTemplatesPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "communication", "read")) {
    redirect("/employee-portals");
  }

  const [templates, routingOptions, templateReadiness] = await Promise.all([
    getEmailTemplateDesignerCatalog(),
    getEmailTemplateRoutingOptions(),
    getEmailTemplateReadinessMetrics(),
  ]);

  return (
    <EmailTemplateManager
      initialPlaceholderHints={getTemplatePlaceholderHints()}
      initialRoutingOptions={routingOptions}
      initialTemplates={templates}
      templateReadiness={templateReadiness}
    />
  );
}
