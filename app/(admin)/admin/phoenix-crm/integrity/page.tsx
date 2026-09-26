import { redirect } from "next/navigation";
import { Eye, ShieldAlert, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { canReadIntegrityBoard, loadIntegrityBoard, type IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";

export const dynamic = "force-dynamic";

/**
 * Location integrity — the Super Admin's and the SFE Manager's board, and the ONLY screen that reads
 * the evidence (owner, 2026-09-26: "recorded in the admin and the SFE account").
 *
 * It sits under /admin, which a rep cannot open at all. That is the whole reason it is a page of its
 * own rather than a tab inside Phoenix CRM: the CRM tabs are the same component tree the field app
 * renders, and one wrong role check there would show a rep that he had been caught. Here there is no
 * such tree to get wrong.
 *
 * Nothing on this page acts. There is no button, no decision, no notification and no write — reading
 * it is the entire feature, and what to do about a case is the owner's call, made with the photo and
 * the day in front of him.
 */
function cairo(value: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function Reasons({ entry }: { entry: IntegrityCase }) {
  return (
    <ul className="space-y-1">
      {entry.reasons.map((reason) => (
        <li key={reason} className="flex items-start gap-2 text-sm leading-6 text-slate-700">
          <span className={`mt-2 h-1.5 w-1.5 shrink-0 ${entry.strong ? "bg-rose-500" : "bg-amber-500"}`} />
          <span>{reason}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function PhoenixCrmIntegrityPage() {
  const access = await resolveAccessContextFromPage();
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadIntegrityBoard(viewer)) redirect("/admin");

  const board = await loadIntegrityBoard(viewer);
  const weakCount = board.cases.length - board.strongCount;

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Location integrity"
        description="Captures whose position Phoenix could not believe — a mock location app the phone admitted to, a coordinate used before, a trip nobody could have made. Nothing here is a verdict and no rep is told: it is where to look, and what to look at."
        icon={<ShieldAlert className="h-3.5 w-3.5" />}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <AdminStatCard
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Strong cases"
          value={board.strongCount}
          description="At least one signal that stands on its own"
          tone="rose"
          size="compact"
        />
        <AdminStatCard
          icon={<Eye className="h-5 w-5" />}
          label="Worth a look"
          value={weakCount}
          description="Corroborating signals only"
          tone="orange"
          size="compact"
        />
        <AdminStatCard
          icon={<Users className="h-5 w-5" />}
          label="Reps involved"
          value={board.byRep.length}
          description="A pattern matters more than an incident"
          tone="blue"
          size="compact"
        />
      </div>

      {board.cases.length === 0 ? (
        <AdminCallout tone="success">
          <span>
            Nothing flagged. Every position captured in Phoenix CRM so far has been one the server could account for — and the checks run on every
            visit and every validated place, whether or not the phone reports anything.
          </span>
        </AdminCallout>
      ) : null}

      {board.byRep.length > 1 ? (
        <AdminTableShell title="By rep" description="Where the same name keeps appearing. One case is an incident; a column of them is a habit.">
          <div className="px-5 py-4 sm:px-6">
            <ul className="space-y-2">
              {board.byRep.map((rep) => (
                <li key={rep.repHrId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-slate-100 pb-2 last:border-0">
                  <span className="text-sm font-semibold text-slate-900">{rep.repName}</span>
                  <span className="text-sm text-slate-600">
                    {rep.strongCases > 0 ? `${rep.strongCases} strong · ` : ""}
                    {rep.cases} in total
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </AdminTableShell>
      ) : null}

      {board.cases.length > 0 ? (
        <AdminTableShell title="Cases" description="Newest first, strong signals at the top. Open the visit itself to see the photo that was taken with it.">
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[16%]" />
                <col className="w-[18%]" />
                <col className="w-[18%]" />
                <col className="w-[34%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">When</th>
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">What is wrong</th>
                  <th className="px-5 py-3">Position</th>
                </tr>
              </thead>
              <tbody>
                {board.cases.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm text-slate-700">
                      <div className="font-semibold text-slate-900">{cairo(entry.capturedAt)}</div>
                      <div className="text-xs text-slate-500">{entry.subjectKind === "place" ? "Validating a place" : "A visit"}</div>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{entry.repName}</td>
                    <td className="px-5 py-4 text-sm text-slate-700">{entry.customerName}</td>
                    <td className="px-5 py-4">
                      <Reasons entry={entry} />
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-600">
                      {entry.lat !== null && entry.lon !== null ? (
                        <span className="tabular-nums">
                          {entry.lat.toFixed(5)}, {entry.lon.toFixed(5)}
                        </span>
                      ) : (
                        "—"
                      )}
                      {entry.accuracyMeters !== null ? <div className="text-xs text-slate-500">within {Math.round(entry.accuracyMeters)} m</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same cases as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {board.cases.map((entry) => (
              <div key={entry.id} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">{cairo(entry.capturedAt)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">
                  {entry.customerName} · {entry.subjectKind === "place" ? "validating a place" : "a visit"}
                </p>
                <div className="mt-3">
                  <Reasons entry={entry} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}
    </div>
  );
}
