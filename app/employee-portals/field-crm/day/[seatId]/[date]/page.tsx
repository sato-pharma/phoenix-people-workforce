import { notFound, redirect } from "next/navigation";

import { BackToPreviousPage } from "@/components/crm/back-to-previous-page";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DayDetailView } from "@/components/phoenix-crm/day-detail-view";
import { CrmEmpty, CrmPanel } from "@/components/phoenix-crm/ui";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { logPortalFailure } from "@/lib/observability/portal-logging";
import { loadPhoenixCrmDayPage } from "@/lib/phoenix-crm/server/day-detail";
import { PHOENIX_CRM_PORTAL_PATH } from "@/lib/phoenix-crm/server/page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Phoenix CRM — one person's day, in full, on its own address.
 *
 * Owner, 2026-09-30, of the team calendar: *"when I press on any day that have activity, I am
 * redirected to a new tab with the full detail of this day, with location, timing, everything."*
 * So the calendar's cells are LINKS, they open here with `target="_blank"`, and this page is a leaf
 * — nothing on it navigates, because the way back is the tab he came from.
 *
 * 🔴 ONE ROUTE, NOT AN ADMIN/PORTAL TWIN PAIR, AND IT IS NOT IN `portal-twins.ts`. The twin table
 * exists so a link into the WRONG shell forwards to the right one; nothing links into this page
 * except a calendar cell, and the portal layout turns nobody away but a guest. A Super Admin
 * reading it from the admin calendar therefore lands here and it renders, where a twin redirect
 * would have bounced him to a page that does not exist. The module chooser is untouched: `day` is
 * three segments deep, so it can never be read as a module slug by `[module]`.
 *
 * 🔴 WHO MAY OPEN IT IS DECIDED IN THE LOADER, not by a rule here. `loadPhoenixCrmDayPage` asks gate one
 * first — the `phoenix_crm` read permission, which a per-account module lock also closes (audit,
 * 2026-10-02: the day page used to skip it) — and then `loadVisitDay`'s own gate decides. That one resolves
 * the territory through the viewer's scope and refuses anything outside it, and it applies
 * `isLocationBlind`: a manager reads the measured location line, and a REP opening his own day
 * reads "Visit saved" with no distance and no flag (Golden rule #1). A second gate on this page
 * would be a second answer to a settled question.
 */
/**
 * Where "Back" goes when there is no page of ours behind this one (opened from a bookmark or a new tab), by a fixed
 * key the opening screen puts in `?from=` — never a free address, so it can only ever point inside the app (owner,
 * 2026-11-09: "when I press on a rep I need a back button to return to the previous page"). Otherwise "Back" returns
 * to the page he pressed the rep on.
 */
const BACK_TO: Record<string, string> = { "team-visits": "/employee-portals/team-visits" };
const BACK_TO_DEFAULT = "/employee-portals/team-calendar";

export default async function PhoenixCrmDayPage({
  params,
  searchParams,
}: {
  params: Promise<{ seatId: string; date: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { date, seatId } = await params;
  // An address that is not a Cairo calendar day is nothing this app ever produced.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) notFound();

  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");

  const query = await searchParams;
  const load = await loadPhoenixCrmDayPage(access, {
    date,
    seatId: decodeURIComponent(seatId),
    test: query.test === "1" || query.test === "true",
  });

  if (load.kind === "ready") {
    return (
      <EmployeePortalPageShell badge="CRM" description="Phoenix CRM · the day in full" title="The day in full">
        <BackToPreviousPage fallbackHref={(typeof query.from === "string" && BACK_TO[query.from]) || BACK_TO_DEFAULT} />
        <DayDetailView view={load.view} />
      </EmployeePortalPageShell>
    );
  }

  if (load.kind === "failed") {
    logPortalFailure(
      { hrId: access.hrId, module: "phoenix-crm", role: access.role, route: `${PHOENIX_CRM_PORTAL_PATH}/day` },
      load.error,
    );
  }

  return (
    <EmployeePortalPageShell badge="CRM" title="The day in full">
      <CrmPanel>
        {load.kind === "failed" ? (
          <CrmEmpty
            message="This is a load failure, not an empty day. Reload the page in a minute."
            title="Phoenix CRM could not load this day"
          />
        ) : (
          <CrmEmpty message={load.message} title="This day is not yours to open" />
        )}
      </CrmPanel>
    </EmployeePortalPageShell>
  );
}
