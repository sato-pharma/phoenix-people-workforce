import { redirect } from "next/navigation";

import { FieldActivityView } from "@/components/field-activity/field-activity-view";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveFieldActivityAccess } from "@/lib/field-activity/access";
import { defaultPeriod } from "@/lib/field-activity/period";

export const dynamic = "force-dynamic";

/**
 * The page is a gate and a shell, nothing more — every figure on it arrives through the API, which
 * applies the scope again. Hiding the sidebar link is UX; this redirect and the route's own check
 * are the security boundary.
 */
export default async function FieldActivityPage() {
  const access = await resolveAccessContextFromPage();
  // Five of this module's eight roles are portal seats. `app/(admin)/layout.tsx` redirects them out
  // of this route group before this page runs, so this line never actually fires — it is the
  // source-of-truth declaration that `portal-twins.ts` lifts up to the layout, sending such a viewer
  // to the portal half instead of dropping them on the portal home. Without the pair, a DM, RM, NSM,
  // PM or GPM who follows a link to this address lands nowhere near the module their grant unlocks,
  // which is exactly how it shipped in #4647.
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/field-activity");
  const resolved = await resolveFieldActivityAccess(access);
  if (!resolved) redirect("/employee-portals");

  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
  const period = defaultPeriod(todayIso);
  return <FieldActivityView defaultFrom={period.fromIso} defaultTo={period.toIso} />;
}
