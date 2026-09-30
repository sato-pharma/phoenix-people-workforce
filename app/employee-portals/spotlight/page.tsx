import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RepSpotlightWorkspace } from "@/components/spotlight/rep-spotlight-workspace";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { currentCairoDateParts } from "@/lib/i18n/format";
import { latestPublishedClosingPeriod } from "@/lib/sales/monthly-closing-publication";
import { SPOTLIGHT_FLOOR } from "@/lib/spotlight/period";
import { REP_SPOTLIGHT_MIN_ACHIEVEMENT } from "@/lib/spotlight/rep-self";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Spotlight — the medical rep's own recognition sheet.
 *
 * The portal twin of the admin `/spotlight` (which stays Super Admin and CEO, company-wide). This one
 * is SELF ONLY, gated on `spotlight_self`: a rep picks any period and sees his achievement against the
 * published closing, and can download a picture or a PDF at 90% and above (owner, 2026-09-30). The
 * numbers are resolved from his own HR id in the API routes — this page hands the workspace only the
 * months to choose from.
 */
function monthsFromFloorToNow(): string[] {
  const { year, month } = currentCairoDateParts();
  const end = year * 12 + (month - 1);
  const floor = Number(SPOTLIGHT_FLOOR.slice(0, 4)) * 12 + (Number(SPOTLIGHT_FLOOR.slice(5, 7)) - 1);
  const out: string[] = [];
  for (let cursor = floor; cursor <= end; cursor += 1) {
    const y = Math.floor(cursor / 12);
    const m = (cursor % 12) + 1;
    out.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

export default async function PortalSpotlightPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");

  try {
    await assertPermission(access, "spotlight_self", "read");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }

  const months = monthsFromFloorToNow();
  // Open on the newest published month — the one most likely to be ready — clamped into the list.
  const latest = await latestPublishedClosingPeriod();
  const fallback = months[months.length - 1] ?? SPOTLIGHT_FLOOR;
  const defaultMonth = latest && months.includes(latest) ? latest : fallback;

  return (
    <EmployeePortalPageShell
      badge="Recognition"
      description="Your own achievement over any period, and your spotlight sheet to share once you reach the mark."
      errorBoundaryTitle="Spotlight unavailable"
      title="Spotlight"
    >
      <RepSpotlightWorkspace
        months={months}
        defaultFrom={defaultMonth}
        defaultTo={defaultMonth}
        threshold={REP_SPOTLIGHT_MIN_ACHIEVEMENT}
      />
    </EmployeePortalPageShell>
  );
}
