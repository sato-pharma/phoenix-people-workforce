import { redirect } from "next/navigation";

import { TabletDashboard } from "@/components/devices/tablet-dashboard";
import { PremiumHero } from "@/components/ui/premium-hero";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isHeadwindConfigured } from "@/lib/devices/headwind/auth";

export const dynamic = "force-dynamic";

/**
 * Tablet Dashboard — Super Admin only, the monitoring face of the company rep tablets.
 *
 * 🔴 GATED ON `company_devices:approve`, the same gate as Rep Tablets beside it. The Rep Tablets page
 * is for enrolling a tablet and setting the rules; this page is for watching and driving the fleet —
 * where each tablet is, what is on it, its screen, and everything it can be driven to do. The page
 * check is UX; the `/api/devices/headwind*` route handlers assert the same permission and are the
 * security boundary. Anyone turned away is sent to the register they CAN use.
 *
 * 🔴 NO CALLS AND NO MESSAGES. The company's Headwind server holds no call log or message history at
 * all — there is nothing of the kind to show, and nothing here reads a rep's calls or messages. This
 * dashboard protects a company asset; it is not a watch on the person carrying it.
 *
 * IT SHIPS DARK UNTIL THE SERVER EXISTS, exactly like the Headwind sections on the Rep Tablets page:
 * with no bridge credential there is nothing to read, so the body is a plain line saying so.
 */
export default async function TabletDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "company_devices", "approve"))) {
    redirect("/hr/devices");
  }

  const headwindReady = isHeadwindConfigured();

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Company devices"
        subtitle="See every company tablet at a glance — where it is, what is on it, its screen, and everything it can be driven to do. Calls and messages are never shown."
        title="Tablet Dashboard"
      />
      {headwindReady ? (
        <TabletDashboard />
      ) : (
        <div className="border border-slate-200 bg-white px-4 py-3">
          <p className="break-words text-[11px] font-semibold text-slate-500">
            The company tablet server is not connected yet, so there is nothing to show here. Once the Headwind server
            is set up on Railway, the fleet, the map and every tablet&rsquo;s detail appear automatically.
          </p>
        </div>
      )}
    </div>
  );
}
