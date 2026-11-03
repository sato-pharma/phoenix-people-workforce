import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NewHireAccountsAdmin } from "@/components/new-hire-accounts/new-hire-accounts-admin";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canSendNewHireAccounts, loadNewHireAccounts } from "@/lib/new-hire-accounts/service";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const dynamic = "force-dynamic";

/**
 * New Hire Accounts — the Super Admin or the SFE Manager sends a new rep or district manager their account.
 *
 * Owner, 2026-11-03: "I want him to be able to send the new accounts to the new hires, but without changing in access
 * or authorities or anything."
 *
 * 🔴 THOSE TWO ALONE — `canSendNewHireAccounts`, on the page and inside every service it calls.
 */
export default async function NewHireAccountsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "approve"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canSendNewHireAccounts(viewer)) redirect("/admin");

  const view = await loadNewHireAccounts(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Send each new rep or district manager the link to set their password, by Sato email, private email or WhatsApp."
        eyebrow="CRM"
        icon={<KeyRound className="h-3.5 w-3.5" />}
        title="New hire accounts"
      />
      <CrmSurfaceProvider surface="admin">
        <NewHireAccountsAdmin view={view} />
      </CrmSurfaceProvider>
    </div>
  );
}
