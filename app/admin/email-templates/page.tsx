import { redirect } from "next/navigation";

import { EmailTemplateManager } from "@/components/admin/email-template-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmailTemplateCatalog,
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
    getEmailTemplateCatalog(),
    getEmailTemplateRoutingOptions(),
    getEmailTemplateReadinessMetrics(),
  ]);

  return (
    <AppShell navigationMode="admin">
      <EmailTemplateManager
        initialPlaceholderHints={getTemplatePlaceholderHints()}
        initialRoutingOptions={routingOptions}
        initialTemplates={templates}
        templateReadiness={templateReadiness}
      />
    </AppShell>
  );
}
