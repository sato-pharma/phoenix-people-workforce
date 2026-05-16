import { redirect } from "next/navigation";

import { EmailTemplateManager } from "@/components/admin/email-template-manager";
import { AppShell } from "@/components/layout/app-shell";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { listEmailTemplates } from "@/lib/email-templates/service";

export const dynamic = "force-dynamic";
export const metadata = { title: "Email Templates — Phoenix Workforce" };

export default async function AdminEmailTemplatesPage() {
  const access = await resolveAccessContextFromPage();

  if (!await canAccess(access, "admin", "read")) {
    redirect("/employee-portals");
  }

  const templates = await listEmailTemplates();

  return (
    <AppShell navigationMode="admin">
      <EmailTemplateManager initialTemplates={templates} />
    </AppShell>
  );
}
