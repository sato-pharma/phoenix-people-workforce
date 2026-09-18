import { redirect } from "next/navigation";

import { RepTabletsConsole } from "@/components/devices/rep-tablets-console";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isAndroidManagementConfigured } from "@/lib/devices/android-web-app";

export const dynamic = "force-dynamic";

/**
 * Rep Tablets — Super Admin only.
 *
 * 🔴 GATED ON `company_devices:approve`, like Managed Google Play beside it. The rules set here reach
 * every enrolled rep tablet at once, and an enrollment code brings a new tablet under them. The page
 * check is UX — the three route handlers assert the same permission, and they are the security
 * boundary. Anyone turned away is sent to the register they CAN use, not out of the shell.
 */
export default async function RepTabletsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "company_devices", "approve"))) {
    redirect("/hr/devices");
  }

  return <RepTabletsConsole enterpriseBound={isAndroidManagementConfigured()} />;
}
