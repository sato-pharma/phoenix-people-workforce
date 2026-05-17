import { redirect } from "next/navigation";

import { EmailTemplateManager } from "@/components/admin/email-template-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getEmailTemplateCatalog,
  getEmailTemplateRoutingOptions,
  getTemplatePlaceholderHints,
} from "@/lib/email-templates/service";

export const dynamic = "force-dynamic";

export default async function AdminEmailTemplatesPage() {
  const access = await resolveAccessContextFromPage();
  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const [templates, routingOptions] = await Promise.all([
    getEmailTemplateCatalog(),
    getEmailTemplateRoutingOptions(),
  ]);

  return (
    <AppShell navigationMode="admin">
      <EmailTemplateManager
        initialPlaceholderHints={getTemplatePlaceholderHints()}
        initialRoutingOptions={routingOptions}
        initialTemplates={templates}
      />
    </AppShell>
  );
}
