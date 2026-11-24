import { redirect } from "next/navigation";
import { Hourglass } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { LateVisitsBoard, type LateVisitsTab } from "@/components/phoenix-crm/late-visits-board";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canEnterMissedRecords, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadLateVisits } from "@/lib/phoenix-crm/server/late-visits";

export const dynamic = "force-dynamic";

/**
 * Late visits — a visit a phone held for want of signal that reached Phoenix after its day closed (owner, 24 Nov 2026:
 * "never any visit to be lost from either a rep or from the manager", then "SUPER ADMIN APPROVE IT ONLY SUPER ADMIN").
 *
 * 🔴 THE SUPER ADMIN'S ALONE — `canEnterMissedRecords`, on the page and inside every service it calls, the same door
 * as "Record a missed visit", because approving one IS entering a missed record. The redirect rather than a message is
 * deliberate: a page that does not describe itself to somebody who may not read it.
 */
export default async function PhoenixCrmLateVisitsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "update"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canEnterMissedRecords(viewer)) redirect("/admin");

  const raw = (await searchParams).tab;
  const tab: LateVisitsTab = raw === "decided" ? "decided" : "waiting";
  const board = await loadLateVisits(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Visits a phone sent after their day closed, and visits logged while the phone gave no location. Each one waits for you, whole, exactly as it was logged. Approve enters it on the day it was pressed; Reject keeps it on file."
        eyebrow="CRM"
        icon={<Hourglass className="h-3.5 w-3.5" />}
        title="Late visits"
      />
      <LateVisitsBoard board={board} tab={tab} />
    </div>
  );
}
