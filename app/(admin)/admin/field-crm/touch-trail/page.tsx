import { redirect } from "next/navigation";
import { Fingerprint, Keyboard, MonitorSmartphone, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard } from "@/components/admin/admin-design-system";
import { TouchTrailBoard } from "@/components/phoenix-crm/touch-trail-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  canReadTouchTrail,
  loadTouchTrailDay,
  loadTouchTrailSession,
} from "@/lib/phoenix-crm/server/touch-trail-reader";

export const dynamic = "force-dynamic";

/**
 * The touch trail — every tap, press and keystroke on Phoenix CRM, read a day at a time.
 *
 * Owner, 2026-10-03, asking for the table: "every click or every touch on the touch screen for this
 * module to be saved in a separate audit trail … every single thing is saved, even if the rep didn't
 * save it." Owner, 2026-10-04, asking for this page: "build the touch trail reader for the Super
 * Admin." Until it existed the table could only be read with hand-written SQL.
 *
 * 🔴 THE SUPER ADMIN'S ALONE — `canReadTouchTrail`, the same gate the place checks use, on the page
 * and inside the service. Two reasons, and the second is the one that would hurt: the trail records
 * EVERY pair of hands on the module including a manager's, so widening it would hand one manager
 * another's keystrokes; and it keeps what a rep typed and then deleted, which is the most private
 * thing the module holds. The redirect rather than a message is the integrity board's shape — a page
 * that does not describe itself to somebody who may not read it.
 *
 * 🔴 GOLDEN RULE #1 IS WHY IT LIVES HERE AND NOWHERE ELSE. The rep's app is easy and BLIND: he is
 * never shown that a trail exists, let alone that it was read. `/admin` is a tree he cannot open.
 */
export default async function PhoenixCrmTouchTrailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadTouchTrail(viewer)) redirect("/admin");

  const params = await searchParams;
  const first = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value);
  const view = await loadTouchTrailDay(viewer, { day: first(params.day), personHrId: first(params.person) });
  const session = await loadTouchTrailSession(viewer, first(params.session) ?? null);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every tap, press, keystroke and screen change on Phoenix CRM, as the browser reported it — including what a rep typed and then deleted. A day is grouped into the page loads that made it; open one to read it event by event. The rep is never shown that this exists, and nothing on this page writes to his work."
        eyebrow="CRM"
        icon={<Fingerprint className="h-3.5 w-3.5" />}
        title="Touch trail"
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <AdminStatCard
          description="Taps, presses, keystrokes and screen changes on the chosen day"
          icon={<Fingerprint className="h-3.5 w-3.5" />}
          label="Events"
          size="compact"
          tone="orange"
          value={view.totals.events.toLocaleString("en-GB")}
        />
        <AdminStatCard
          description="One per page load — a rep's morning is usually several"
          icon={<MonitorSmartphone className="h-3.5 w-3.5" />}
          label="Page loads"
          size="compact"
          tone="blue"
          value={view.totals.sessions.toLocaleString("en-GB")}
        />
        <AdminStatCard
          description="Whose hands were on the module, reps and managers alike"
          icon={<Users className="h-3.5 w-3.5" />}
          label="People"
          size="compact"
          tone="violet"
          value={view.totals.people.toLocaleString("en-GB")}
        />
        <AdminStatCard
          description="Distinct screens reached across the day"
          icon={<Keyboard className="h-3.5 w-3.5" />}
          label="Screens"
          size="compact"
          tone="emerald"
          value={view.totals.screens.toLocaleString("en-GB")}
        />
      </div>

      {/* Said out loud because the admin layout mounts the collector over this subtree: reading the
          trail writes to it, so the reader's OWN page loads appear in the list below. That is
          deliberate — every pair of hands on the module is recorded — and a reader who did not know
          it would read his own sessions as somebody else's. */}
      <AdminCallout tone="neutral">
        <span>
          Your own sessions appear here too. The trail covers this side of the module on purpose, so a manager entering a visit
          for a rep is recorded exactly as the rep is — and this page is part of the module.
        </span>
      </AdminCallout>

      <TouchTrailBoard session={session} view={view} />
    </div>
  );
}
