import { redirect } from "next/navigation";

import { HeadwindFleet } from "@/components/devices/headwind-fleet";
import { ManageEngineAppRepository } from "@/components/devices/manageengine-app-repository";
import { ManageEngineEnrollment } from "@/components/devices/manageengine-enrollment";
import { ManageEngineFleet } from "@/components/devices/manageengine-fleet";
import { ManageEngineRepTabletRules } from "@/components/devices/manageengine-rep-tablet-rules";
import { PremiumHero } from "@/components/ui/premium-hero";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isHeadwindConfigured } from "@/lib/devices/headwind/auth";
import { isManageEngineConfigured } from "@/lib/devices/manageengine/auth";

export const dynamic = "force-dynamic";

/**
 * Rep Tablets — Super Admin only.
 *
 * 🔴 GATED ON `company_devices:approve`, like Managed Google Play beside it. The rules set here reach
 * every enrolled rep tablet at once, and an enrollment code brings a new tablet under them. The page
 * check is UX — the route handlers assert the same permission, and they are the security boundary.
 * Anyone turned away is sent to the register they CAN use, not out of the shell.
 *
 * MANAGEENGINE FIRST SINCE 2026-09-25 (owner's instruction). It is the path that actually enrolls:
 * Google gives a new Cloud project a device quota of ZERO until it approves an application, so a
 * tablet scanning the Google code is refused — "your organization has reached its usage limits" —
 * while the enterprise holds no tablets at all. So the order reads as the work does: enroll through
 * ManageEngine, then the two company-wide things a tablet is later put ON — the rules, and the app
 * repository that every tablet's Apps section can only offer from — then the ManageEngine fleet and
 * everything that can be done to a tablet in it, and
 * only then Google's console.
 *
 * GOOGLE CONSOLE TAKEN OFF THIS PAGE 2026-09-25 (owner's instruction). It rendered a full second
 * copy of every ManageEngine card above — its own enrollment QR, rules, app list and enrolled-tablet
 * table — while Google holds ZERO tablets and cannot enroll one (quota zero), so the whole "second
 * path" was pure duplication on the page. Nothing Google-side was DELETED: the `RepTabletsConsole`
 * component and every `app/api/devices/tablets/*` route it calls stay in the repo untouched. The day
 * Google approves the quota, re-add the one `<RepTabletsConsole …/>` line below and it works again
 * exactly as written.
 */
export default async function RepTabletsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "company_devices", "approve"))) {
    redirect("/hr/devices");
  }

  // The rules card reads ManageEngine on mount, so it is only mounted once the bridge has a
  // credential — with none, it could say nothing except that it cannot connect, which the enrollment
  // section above it already says once.
  const manageEngineReady = isManageEngineConfigured();

  // 🔴 THE HEADWIND SECTION SHIPS DARK. It renders ONLY once the company's own Headwind server exists
  // and its three settings are on Railway; until then this page is byte-for-byte what it is today, so
  // the whole bridge can be merged to production before the server is built. When the fleet has moved
  // across, the ManageEngine lines come off exactly the way the Google console did — one line, with
  // nothing deleted from the repo.
  const headwindReady = isHeadwindConfigured();

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Company devices"
        subtitle="Enroll a new tablet with a QR code, drive every enrolled tablet from here, and see them all beside the custody register. A tablet enrolled here is the company's from its first screen."
        title="Rep Tablets"
      />
      <ManageEngineEnrollment />
      {manageEngineReady ? <ManageEngineRepTabletRules /> : null}
      {manageEngineReady ? <ManageEngineAppRepository /> : null}
      <ManageEngineFleet bridgeConfigured={manageEngineReady} />
      {headwindReady ? <HeadwindFleet /> : null}
    </div>
  );
}
