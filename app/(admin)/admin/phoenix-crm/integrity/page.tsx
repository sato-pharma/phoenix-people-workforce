import { redirect } from "next/navigation";
import { Eye, ShieldAlert, Users } from "lucide-react";

import { AdminCallout, AdminPageHero, AdminStatCard, AdminTableShell } from "@/components/admin/admin-design-system";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import {
  canReadIntegrityBoard,
  integritySourceLabel,
  loadIntegrityBoard,
  readsPositionCases,
  type BehaviourCase,
  type IntegrityCase,
} from "@/lib/phoenix-crm/server/integrity-board";

export const dynamic = "force-dynamic";

/**
 * Location integrity — the Super Admin's and the SFE Manager's board, and the ONLY screen that reads
 * the evidence (owner, 2026-09-26: "recorded in the admin and the SFE account").
 *
 * 🔒 IT CARRIES THREE DETECTORS AND KEEPS ITS NAME. The position checks judge one fix, the nightly
 * photo sweep judges one picture (D5, source "photo"), and the behaviour pass judges a rep's whole
 * month (D4, its own table and its own section below). The name says one of the three, and that was
 * PUT TO THE OWNER on 2026-09-27 once it had stopped describing the board. He answered "keep the
 * name Location integrity". Settled, not deferred: never re-propose a rename when a fourth detector
 * lands — widen the description instead.
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

function monthName(month: string): string {
  const [year, index] = month.split("-").map((part) => Number(part));
  if (!Number.isFinite(year) || !Number.isFinite(index)) return month;
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(Date.UTC(year, index - 1, 1)));
}

function BehaviourReasons({ entry }: { entry: BehaviourCase }) {
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

/**
 * Where the capture was read, how sure the phone was, and how far it fell from the place it names.
 * One component for the table cell AND the phone card, so the two can never print different facts
 * (Phoenix CRM audit, 2026-10-02: the card dropped this whole column).
 */
function Position({ entry }: { entry: IntegrityCase }) {
  return (
    <>
      {entry.lat !== null && entry.lon !== null ? (
        <span className="tabular-nums">
          {entry.lat.toFixed(5)}, {entry.lon.toFixed(5)}
        </span>
      ) : (
        "—"
      )}
      {entry.accuracyMeters !== null ? <div className="text-xs text-slate-500">within {Math.round(entry.accuracyMeters)} m</div> : null}
      {/* How far the visit was saved from the place it names. Read from the visit
          row, so this board and the place-vs-actual report can never print two
          different numbers for one visit. Null is UNKNOWN and is simply absent -
          it must not render as 0 m, which is a rep standing exactly on the pin. */}
      {entry.placeDistanceMeters !== null ? (
        <div className="text-xs text-slate-500">
          {entry.placeDistanceMeters < 1000
            ? `${Math.round(entry.placeDistanceMeters)} m from the place`
            : `${(entry.placeDistanceMeters / 1000).toFixed(1)} km from the place`}
        </div>
      ) : null}
    </>
  );
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
  // Gate one before the organogram (audit, 2026-10-02): a per-account module lock on Phoenix CRM
  // closes this page as well, which `canReadIntegrityBoard` alone — a role test — never did.
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadIntegrityBoard(viewer)) redirect("/admin");

  const board = await loadIntegrityBoard(viewer);
  const weakCount = board.cases.length - board.strongCount;
  // The position cases are the Super Admin's alone (owner, 2026-10-02); the service never queries them
  // for the SFE Manager, so his page must not describe a detector whose cases it will never show him.
  const positions = readsPositionCases(viewer);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="CRM"
        title="Location integrity"
        description={
          positions
            ? "Captures Phoenix could not account for — a mock location app the phone admitted to, a coordinate used before, a trip nobody could have made, a photograph that had already been sent, or a month whose shape no honest month has. Nothing here is a verdict and no rep is told: it is where to look, and what to look at."
            : "Captures Phoenix could not account for — a photograph that had already been sent, or a month whose shape no honest month has. Nothing here is a verdict and no rep is told: it is where to look, and what to look at."
        }
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
            {positions
              ? "Nothing flagged. Every position and every photograph captured in Phoenix CRM so far has been one the server could account for — and the checks run on every visit and every validated place, whether or not the phone reports anything."
              : "Nothing flagged. Every photograph captured in Phoenix CRM so far has been one the server could account for — and the check runs on every visit and every validated place."}
          </span>
        </AdminCallout>
      ) : null}

      {board.bySource.length > 1 ? (
        <AdminCallout tone="neutral">
          <span>
            {board.bySource.map((entry) => `${entry.label.toLowerCase()} ${entry.cases}`).join(" · ")} — which check filed each case. A capture can carry
            one from each, and they are counted apart because a re-used photograph and an impossible journey are different things to look at.
          </span>
        </AdminCallout>
      ) : null}

      {board.behaviour.length > 0 ? (
        <AdminTableShell
          title="Months that do not look like months"
          description="A whole month of one rep's work, judged on its shape rather than on any single capture — a form that takes exactly the same time again and again, a list covered with nothing sold behind it. Only the repeated duration is a thing a person cannot do; everything else is worth reading beside it, never on its own. A pattern in WHEN they saved their visits appears only alongside one of those, because a rep may enter the day until 02:00 and entering it in one sitting is not a finding."
        >
          {/* Desktop: the full table. `table-fixed` with a colgroup, never a min-width in a scroller. */}
          <div className="hidden lg:block">
            <table className="w-full table-fixed border-collapse">
              <colgroup>
                <col className="w-[20%]" />
                <col className="w-[18%]" />
                <col className="w-[12%]" />
                <col className="w-[50%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs font-bold uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3">Rep</th>
                  <th className="px-5 py-3">Month</th>
                  <th className="px-5 py-3">Visits</th>
                  <th className="px-5 py-3">What is wrong</th>
                </tr>
              </thead>
              <tbody>
                {board.behaviour.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 align-top even:bg-slate-50/60">
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{entry.repName}</td>
                    <td className="px-5 py-4 text-sm text-slate-700">{monthName(entry.month)}</td>
                    <td className="px-5 py-4 text-sm tabular-nums text-slate-700">{entry.visits}</td>
                    <td className="px-5 py-4">
                      <BehaviourReasons entry={entry} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: the same months as cards. */}
          <div className="space-y-3 px-5 py-4 lg:hidden sm:px-6">
            {board.behaviour.map((entry) => (
              <div key={entry.id} className="border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="text-sm font-bold text-slate-900">{entry.repName}</span>
                  <span className="text-xs text-slate-500">{monthName(entry.month)}</span>
                </div>
                <p className="mt-1 text-sm text-slate-700">{entry.visits} visits</p>
                <div className="mt-3">
                  <BehaviourReasons entry={entry} />
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}

      {board.behaviourNotChecked > 0 ? (
        <AdminCallout tone="neutral">
          <span>
            {board.behaviourNotChecked} rep-months held too few visits to judge on shape, so they were not checked — which is not the same as clean. A
            month of leave and a month of nothing look alike from here, and neither is a finding.
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
                <col className="w-[17%]" />
                <col className="w-[17%]" />
                <col className="w-[36%]" />
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
                      <div className="text-xs text-slate-500">
                        {entry.subjectKind === "place" ? "Validating a place" : "A visit"} · {integritySourceLabel(entry.source).toLowerCase()}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-sm font-semibold text-slate-900">{entry.repName}</td>
                    <td className="px-5 py-4 text-sm text-slate-700">{entry.customerName}</td>
                    <td className="px-5 py-4">
                      <Reasons entry={entry} />
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-600">
                      <Position entry={entry} />
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
                  {entry.customerName} · {entry.subjectKind === "place" ? "validating a place" : "a visit"} · {integritySourceLabel(entry.source).toLowerCase()}
                </p>
                <div className="mt-3">
                  <Reasons entry={entry} />
                </div>
                <div className="mt-3 border-t border-slate-100 pt-3 text-sm text-slate-600">
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-500">Position</div>
                  <div className="mt-1 break-words">
                    <Position entry={entry} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </AdminTableShell>
      ) : null}
    </div>
  );
}
