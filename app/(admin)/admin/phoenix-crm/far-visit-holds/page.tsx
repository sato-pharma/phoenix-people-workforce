import { redirect } from "next/navigation";
import { CheckCircle2, Hourglass, XCircle } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { FarVisitHoldActions } from "@/components/admin/far-visit-hold-actions";
import { TryLocationsMap } from "@/components/admin/refused-try-map";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  canDecideFarVisitHolds,
  FAR_VISIT_HOLDS_DECIDED_DAYS,
  loadFarVisitHolds,
  type FarVisitHoldRow,
} from "@/lib/phoenix-crm/server/far-visit-safeguards";

export const dynamic = "force-dynamic";

/**
 * Visits held for SFE — a rep's visit SAVED and waiting for the SFE instead of refused, after five far
 * refusals from one tight spot on one customer in one day (owner, 2026-11-10: "how to avoid these issues so
 * they never happen again?", answer C). Five refusals from one spot mean the customer's saved PLACE is
 * almost certainly wrong — Momen Fathy was refused 51 times at Dr. Doria Darraz's door because her place
 * was saved 8.3 km away from an indoor Wi-Fi guess.
 *
 * The Super Admin and the SFE Manager only (`canDecideFarVisitHolds`, asked here, in the service and in the
 * route). A held visit counts in nothing until the SFE approves it; a refused one never counts. The map is
 * the refused-readings board's own: where the rep stood beside the customer's saved place.
 */
function cairo(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function cairoDay(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Cairo", day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
}

function distanceWords(entry: FarVisitHoldRow): string {
  if (entry.distanceMeters === null) return `Past the ${entry.farMeters} m line from the saved place.`;
  const away = entry.distanceMeters < 1000 ? `${entry.distanceMeters} m` : `${(entry.distanceMeters / 1000).toFixed(1)} km`;
  return `${away} from the saved place; a visit is refused past ${entry.farMeters} m.`;
}

function Status({ entry }: { entry: FarVisitHoldRow }) {
  if (entry.status === "sfe_pending") return <span className="text-sm font-semibold text-slate-900">Waiting for SFE</span>;
  const verb = entry.status === "approved" ? "Approved — it counts" : "Refused — it does not count";
  return (
    <span className="text-sm text-slate-700">
      <span className="font-semibold text-slate-900">{verb}</span>
      {entry.decidedBy || entry.decidedAt ? (
        <span className="block text-xs text-slate-500">
          {[entry.decidedBy, entry.decidedAt ? cairo(entry.decidedAt) : null].filter(Boolean).join(" · ")}
        </span>
      ) : null}
    </span>
  );
}

function What({ entry }: { entry: FarVisitHoldRow }) {
  return (
    <>
      <p className="text-sm leading-6 text-slate-700">
        Refused {entry.tries} {entry.tries === 1 ? "time" : "times"} from the same spot that day, then this visit was saved and held. {distanceWords(entry)}
      </p>
      <div className="mt-3">
        <TryLocationsMap map={entry.map} savedPlace={entry.place} tryPoint={entry.spot} />
      </div>
    </>
  );
}

function Decide({ entry }: { entry: FarVisitHoldRow }) {
  if (entry.status !== "sfe_pending") return <Status entry={entry} />;
  return <FarVisitHoldActions isTest={entry.isTest} placeId={entry.placeId} seatId={entry.seatId} spot={entry.spot} visitId={entry.visitId} />;
}

export default async function PhoenixCrmFarVisitHoldsPage() {
  const access = await resolveAccessContextFromPage();
  // Gate one before the organogram: a per-account module lock on Phoenix CRM closes this page as well,
  // which `canDecideFarVisitHolds` alone — a role test — would not.
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canDecideFarVisitHolds(viewer)) redirect("/admin");

  const holds = await loadFarVisitHolds(viewer);
  const waiting = holds.filter((entry) => entry.status === "sfe_pending");
  const decided = holds.filter((entry) => entry.status !== "sfe_pending");
  const approved = decided.filter((entry) => entry.status === "approved").length;

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Visits held for SFE"
        description={`A rep refused five times in one day from the same spot at one customer is almost certainly standing at the right door with the customer's place saved in the wrong one. Their next visit from that spot is saved and held here instead of refused. It counts in nothing until SFE approves it. If the spot on the map is the customer's real place, move the place there. Decided visits stay on the page for ${FAR_VISIT_HOLDS_DECIDED_DAYS} days.`}
        icon={<Hourglass className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard icon={<Hourglass className="h-5 w-5" />} label="Waiting" value={waiting.length} description="Saved and held, counting in nothing yet" tone="orange" size="compact" />
        <AdminStatCard icon={<CheckCircle2 className="h-5 w-5" />} label="Approved" value={approved} description={`In the last ${FAR_VISIT_HOLDS_DECIDED_DAYS} days`} tone="blue" size="compact" />
        <AdminStatCard icon={<XCircle className="h-5 w-5" />} label="Refused" value={decided.length - approved} description={`In the last ${FAR_VISIT_HOLDS_DECIDED_DAYS} days`} tone="rose" size="compact" />
      </div>

      {holds.length === 0 ? (
        <AdminCallout tone="success">
          <span>No visit is held. No rep has been refused five times from one spot at one customer in the last {FAR_VISIT_HOLDS_DECIDED_DAYS} days.</span>
        </AdminCallout>
      ) : null}

      {holds.length > 0 ? (
        <AdminTableShell title="Held visits" description="Waiting first, newest first. Each row's map shows where the rep stood beside the customer's saved place.">
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[52%]" />
                <col className="w-[28%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Rep and customer</th>
                  <th className="px-5 py-3">What happened</th>
                  <th className="px-5 py-3">Decision</th>
                </tr>
              </thead>
              <tbody>
                {[...waiting, ...decided].map((entry) => (
                  <tr key={entry.visitId} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm">
                      <div className="font-semibold text-slate-900">{entry.repName}</div>
                      <div className="text-slate-700">{entry.customerName}</div>
                      <div className="text-xs text-slate-500">{entry.territory}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        Visit of {cairoDay(entry.visitDate)} · held {cairo(entry.heldAt)}
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <What entry={entry} />
                    </td>
                    <td className="px-5 py-4">
                      <Decide entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same visits as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {[...waiting, ...decided].map((entry) => (
              <div key={entry.visitId} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">held {cairo(entry.heldAt)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {entry.customerName} · {entry.territory}
                </p>
                <div className="mt-3">
                  <What entry={entry} />
                </div>
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <Decide entry={entry} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}
    </div>
  );
}
