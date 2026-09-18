import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ManagedPlayConsole } from "@/components/devices/managed-play-console";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { ENTERPRISE_RESULT_COOKIE } from "@/lib/devices/android-enterprise-signup";
import { isAndroidManagementConfigured } from "@/lib/devices/android-web-app";

export const dynamic = "force-dynamic";

/**
 * Managed Google Play — Super Admin only.
 *
 * 🔴 GATED ON `company_devices:approve`, NOT `read`. The sibling device register is custody
 * paperwork and HR Operations runs it; this page publishes software onto every rep's tablet, and
 * `approve` is the action the permission matrix already reserves to Super Admin. The page check is
 * UX — the three route handlers assert the same permission, and they are the security boundary.
 *
 * The redirect target is `/hr/devices` rather than `/employee-portals`: anyone who can reach this
 * address at all can see the register, so sending them to the page they CAN use beats bouncing them
 * out of the shell entirely.
 */
export default async function ManagedPlayPage({
  searchParams,
}: {
  searchParams: Promise<{ signupError?: string }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "company_devices", "approve"))) {
    redirect("/hr/devices");
  }

  const { signupError } = await searchParams;
  // Written by the signup callback and read exactly once here. A Server Component cannot clear a
  // cookie, so it is short-lived by design rather than deleted — see the note on the constant.
  const newEnterpriseName = (await cookies()).get(ENTERPRISE_RESULT_COOKIE)?.value?.trim() || null;

  return (
    <ManagedPlayConsole
      enterpriseBound={isAndroidManagementConfigured()}
      newEnterpriseName={newEnterpriseName}
      signupError={signupError?.trim() || null}
    />
  );
}
