import { CalendarCheck2, Info } from "lucide-react";

import type { PhoenixTeamReadinessPanelData, PhoenixTeamReadinessRow } from "@/lib/crm/phoenix-team-readiness";

/**
 * WHICH TEAM IS READY TO START IN PHOENIX CRM — read beside the Start button, never on a page of
 * its own, because the decision and the evidence belong in one glance (`/admin/crm`, under "Teams
 * counted from Phoenix CRM").
 *
 * 🔴 THE HEADLINE IS "REPS WITH A LIST", NOT "SEATS FILLED". Pedia Upper Egypt 1 read 6 rep seats,
 * all six filled, on 2026-10-03 — and five of those reps had been hired in the previous four days
 * and carried no customers at all. The rules and the measurement are in
 * `src/lib/crm/phoenix-team-readiness.ts`; this file only renders what it was handed.
 *
 * Super Admin only, by where it sits: the CRM hub redirects everyone else. A Medical Rep must never
 * reach a board that judges his list (Phoenix CRM golden rule #1 — the rep's app is blind).
 *
 * Built to the owner's two locked looks: SQUARE EDGES (no radius anywhere), and FITS THE SCREEN —
 * `w-full table-fixed` with a `<colgroup>` whose widths total 100%, five columns reached by MERGING
 * (the line and the start date ride in the team cell, carried and validated share one), the table
 * `hidden md:block` with a card list under it, no `overflow-x-auto` at any width, and every cell
 * wrapping. Nothing is ever truncated with an ellipsis.
 */

const THEAD = "px-3 py-2.5 text-left align-bottom text-phx-sm font-black uppercase tracking-[0.12em] text-white";
const CELL = "break-words px-3 py-2.5 align-top text-xs leading-5 text-slate-700";
const NUMBER = "break-words px-3 py-2.5 align-top text-right text-xs font-bold leading-5 tabular-nums text-slate-900";

/** One tone per verdict — the colour is the only shorthand, the words always say it too. */
function toneOf(row: PhoenixTeamReadinessRow): { text: string; label: string } {
  if (row.verdict === "counted") return { text: "text-sky-700", label: "Counted from Phoenix CRM" };
  if (row.verdict === "ready") return { text: "text-emerald-700", label: "Ready to start" };
  if (row.verdict === "nearly") return { text: "text-amber-700", label: "Nearly ready" };
  return { text: "text-rose-700", label: "Not ready yet" };
}

function seatDetail(row: PhoenixTeamReadinessRow): string {
  const parts = [
    row.repSeats === 1 ? "1 rep seat" : `${row.repSeats} rep seats`,
    row.people === 1 ? "1 person" : `${row.people} people`,
  ];
  if (row.vacantSeats > 0) parts.push(row.vacantSeats === 1 ? "1 vacant" : `${row.vacantSeats} vacant`);
  return parts.join(" · ");
}

function newHireText(row: PhoenixTeamReadinessRow): string {
  if (row.newHires === 0) return "None";
  const names = row.newHireNames.join(", ");
  const count = row.newHires === 1 ? "1 rep" : `${row.newHires} reps`;
  return names ? `${count}: ${names}` : count;
}

function TeamIdentity({ row }: { row: PhoenixTeamReadinessRow }) {
  return (
    <>
      <p className="break-words text-xs font-bold leading-5 text-slate-900" dir="auto">
        {row.team}
      </p>
      <p className="mt-0.5 flex items-start gap-1.5 break-words text-phx-xs leading-5 text-slate-600">
        {row.started ? <CalendarCheck2 aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" /> : null}
        <span className="min-w-0">{row.startedLine}</span>
      </p>
      {/* A person on two seats is what inflates a count, so it is NAMED rather than silently folded. */}
      {row.managerAlsoRepName ? (
        <p className="mt-0.5 break-words text-phx-xs font-semibold leading-5 text-amber-700">
          {row.managerAlsoRepName} holds the district manager seat and a rep seat on this team — counted once
        </p>
      ) : null}
    </>
  );
}

function ReadinessHeadline({ row }: { row: PhoenixTeamReadinessRow }) {
  const tone = toneOf(row);
  return (
    <>
      {/* The verdict is in WORDS in both halves — the colour is a shorthand, never the only carrier. */}
      <p className={`break-words text-xs font-bold leading-5 ${tone.text}`}>{tone.label}</p>
      <p className="mt-0.5 break-words text-xs font-bold leading-5 text-slate-900">{row.repsWithListLine}</p>
      <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-500">{seatDetail(row)}</p>
      {row.blockers.length > 0 ? (
        <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-600">{row.blockers.join(" · ")}</p>
      ) : null}
    </>
  );
}

function CustomersCell({ row }: { row: PhoenixTeamReadinessRow }) {
  return (
    <>
      <p className="break-words text-xs font-bold leading-5 tabular-nums text-slate-900">
        {row.customersCarried.toLocaleString("en-US")} carried
      </p>
      <p className="mt-0.5 break-words text-phx-xs leading-5 tabular-nums text-slate-500">
        {row.customersValidated.toLocaleString("en-US")} validated
      </p>
    </>
  );
}

export function CrmPhoenixTeamReadinessPanel({ data }: { data: PhoenixTeamReadinessPanelData | null }) {
  return (
    <div className="scroll-mt-4 border border-slate-200 bg-white" id="phoenix-team-readiness">
      <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
        <h2 className="text-phx-sm font-bold uppercase tracking-widest text-slate-300">Ready to start in Phoenix CRM</h2>
        <div className="h-1.5 w-12 bg-orange-500" />
      </div>

      <p className="flex items-start gap-2 border-b border-slate-100 bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-600">
        <Info aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
        <span className="min-w-0">
          A team is ready when its reps HAVE A LIST — a rep seat carrying at least one real customer. Seats filled is not the
          same thing: a rep hired this week fills a seat and carries nobody, so the reps hired in the last{" "}
          {data?.windowDays ?? 30} days are named here and an empty seat explains itself. Test customers are left out
          everywhere. A rep holding two seats is one person. Visits are this team&apos;s iReports360 visits until it starts,
          and its Phoenix CRM visits from the Saturday it does. Teams not started come first, the readiest at the top.
        </span>
      </p>

      {data === null || !data.readable ? (
        <p className="px-5 py-4 text-sm text-slate-500">The readiness figures could not be read just now.</p>
      ) : data.rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-slate-500">The organogram holds no team with rep seats.</p>
      ) : (
        <>
          {/* Desktop: one wide row per team. Gated `hidden md:block` so a phone gets the cards below. */}
          <div className="hidden md:block">
            <table className="w-full table-fixed">
              <colgroup>
                <col style={{ width: "34%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "8%" }} />
              </colgroup>
              <thead className="bg-slate-900">
                <tr>
                  <th className={THEAD} scope="col">
                    Team
                  </th>
                  <th className={THEAD} scope="col">
                    Reps with a list
                  </th>
                  <th className={THEAD} scope="col">
                    Hired in the last {data.windowDays} days
                  </th>
                  <th className={THEAD} scope="col">
                    Customers
                  </th>
                  <th className={`${THEAD} text-right`} scope="col">
                    Visits
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.map((row) => (
                  <tr key={row.teamSeatId}>
                    <td className={CELL}>
                      <TeamIdentity row={row} />
                      <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-500">{row.lineName ?? "Line not set"}</p>
                    </td>
                    <td className={CELL}>
                      <ReadinessHeadline row={row} />
                    </td>
                    <td className={CELL}>{newHireText(row)}</td>
                    <td className={CELL}>
                      <CustomersCell row={row} />
                    </td>
                    <td className={NUMBER}>{row.visits.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone: cards, never a sideways-scrolling table. Same facts, same words. */}
          <ul className="divide-y divide-slate-100 md:hidden">
            {data.rows.map((row) => {
              return (
                <li className="px-5 py-3" key={row.teamSeatId}>
                  <TeamIdentity row={row} />
                  <div className="mt-1.5">
                    <ReadinessHeadline row={row} />
                  </div>
                  <dl className="mt-1.5 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-phx-xs font-semibold text-slate-500">Line</dt>
                      <dd className="min-w-0 break-words text-phx-xs text-slate-700">{row.lineName ?? "Line not set"}</dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-phx-xs font-semibold text-slate-500">Hired in the last {data.windowDays} days</dt>
                      <dd className="min-w-0 break-words text-phx-xs text-slate-700">{newHireText(row)}</dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-phx-xs font-semibold text-slate-500">Customers</dt>
                      <dd className="min-w-0 break-words text-phx-xs tabular-nums text-slate-700">
                        {row.customersCarried.toLocaleString("en-US")} carried ·{" "}
                        {row.customersValidated.toLocaleString("en-US")} validated
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="text-phx-xs font-semibold text-slate-500">Visits in the last {data.windowDays} days</dt>
                      <dd className="min-w-0 break-words text-phx-xs tabular-nums text-slate-700">
                        {row.visits.toLocaleString("en-US")}
                      </dd>
                    </div>
                  </dl>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
