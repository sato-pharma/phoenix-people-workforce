import type { HoldoutRow, HoldoutTag, HoldoutTeam } from "@/lib/crm/ireports360-holdouts";
import type { IReports360HoldoutsData } from "@/lib/crm/ireports360-holdouts-server";

/**
 * WHO STILL RECORDS A DAY ONLY IN iREPORTS360 — a tab on the CRM hub (owner, 2026-11-03). It offers no
 * action and gives nobody a verdict; the rules are in `src/lib/crm/ireports360-holdouts.ts`.
 *
 * The owner's two locked looks: square edges, and fits the screen. `w-full table-fixed` with a colgroup
 * totalling 100%, the tag merged into the person's cell, a card list under `md`, every cell wrapping, no
 * sideways scroll and no ellipsis.
 */

const THEAD = "px-3 py-2.5 text-left align-bottom text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const THEAD_NUMBER = "px-3 py-2.5 text-right align-bottom text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const CELL = "break-words px-3 py-2.5 align-top text-xs leading-5 text-slate-700";
const NUMBER = "break-words px-3 py-2.5 align-top text-right text-xs font-bold leading-5 tabular-nums text-slate-900";

const TAG_LABEL: Record<HoldoutTag, string> = {
  "keeps both apps by ruling": "Keeps both apps by ruling",
  "leaving or left": "Leaving or left",
  "no CRM charge": "No CRM charge",
  "no deduction": "No deduction",
};

function shortDay(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`));
}

function teamLine(team: HoldoutTeam): string {
  const since = team.startsOn ? shortDay(team.startsOn) : null;
  if (team.state === "running" || team.state === "stopping") return `${team.team}: counted from Phoenix${since ? ` since ${since}` : ""}`;
  if (team.state === "starts") return `${team.team}: starts${since ? ` ${since}` : " soon"}`;
  if (team.state === "stopped") return `${team.team}: start stopped`;
  return `${team.team}: not started`;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-phx-line bg-white px-3 py-2.5">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="mt-1 text-base font-black tabular-nums text-slate-950">{value}</p>
    </div>
  );
}

function Person({ row }: { row: HoldoutRow }) {
  return (
    <>
      <p className="break-words text-xs font-bold leading-5 text-slate-900" dir="auto">{row.name}</p>
      {row.tag ? <p className="mt-0.5 break-words text-phx-xs font-bold leading-5 text-slate-500">{TAG_LABEL[row.tag]}</p> : null}
    </>
  );
}

function Standing({ row, teamsReadable }: { row: HoldoutRow; teamsReadable: boolean }) {
  return (
    <>
      <p className={`break-words text-xs font-bold leading-5 ${row.onlyIReports360 ? "text-rose-700" : "text-amber-700"}`}>
        {row.onlyIReports360 ? "Only iReports360" : "Both, with days only in iReports360"}
      </p>
      {teamsReadable
        ? row.teams.map((team) => (
            <p className="mt-0.5 break-words text-phx-xs leading-5 text-slate-600" dir="auto" key={team.team}>{teamLine(team)}</p>
          ))
        : null}
    </>
  );
}

function Rows({ rows, teamsReadable }: { rows: readonly HoldoutRow[]; teamsReadable: boolean }) {
  return (
    <>
      <div className="hidden border border-phx-line bg-white md:block">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: "26%" }} />
            <col style={{ width: "38%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "12%" }} />
          </colgroup>
          <thead className="bg-phx-ink">
            <tr>
              <th className={THEAD} scope="col">Person</th>
              <th className={THEAD} scope="col">Where they record, and their team</th>
              <th className={THEAD_NUMBER} scope="col">Days only there</th>
              <th className={THEAD_NUMBER} scope="col">Last such day</th>
              <th className={THEAD_NUMBER} scope="col">On a rep&apos;s row</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-phx-line">
            {rows.map((row) => (
              <tr key={row.key}>
                <td className={CELL}><Person row={row} /></td>
                <td className={CELL}><Standing row={row} teamsReadable={teamsReadable} /></td>
                <td className={NUMBER}>{row.daysOnlyThere}</td>
                <td className={NUMBER}>{shortDay(row.lastDayOnlyThere)}</td>
                <td className={NUMBER}>{row.daysOnSomeoneElsesRow}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 md:hidden">
        {rows.map((row) => (
          <li className="border border-phx-line bg-white p-3" key={row.key}>
            <Person row={row} />
            <div className="mt-1"><Standing row={row} teamsReadable={teamsReadable} /></div>
            <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div><dt className="text-slate-500">Days only there</dt><dd className="font-bold tabular-nums text-slate-900">{row.daysOnlyThere}</dd></div>
              <div><dt className="text-slate-500">Last such day</dt><dd className="font-bold tabular-nums text-slate-900">{shortDay(row.lastDayOnlyThere)}</dd></div>
              <div><dt className="text-slate-500">On a rep&apos;s row</dt><dd className="font-bold tabular-nums text-slate-900">{row.daysOnSomeoneElsesRow}</dd></div>
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

export function CrmIReports360HoldoutsPanel({ data, error }: { data: IReports360HoldoutsData | null; error: string | null }) {
  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-black tracking-tight text-slate-950">Who still records a day only in iReports360</h2>
        <p className="text-sm leading-6 text-slate-600">
          {data ? `${shortDay(data.from)} to ${shortDay(data.to)}. ` : ""}
          A day counts here when iReports360 holds it and Phoenix CRM holds no visit or activity for that person that day.
          This list changes nothing.
        </p>
      </header>

      {error ? (
        <div className="border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700" role="alert">
          Could not read this, so nothing can be said about who is left. {error}
        </div>
      ) : null}

      {data ? (
        <>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            <Stat label="Only iReports360" value={data.report.onlyIReports360} />
            <Stat label="Both, some days only there" value={data.report.recordsInBoth} />
            <Stat label="Person-days only there" value={data.report.personDaysOnlyThere} />
          </div>
          {data.report.rows.length === 0 ? (
            <div className="border border-phx-line bg-white p-4 text-sm leading-6 text-slate-700">Nobody appears in this window.</div>
          ) : (
            <Rows rows={data.report.rows} teamsReadable={data.teamsReadable} />
          )}
          {!data.teamsReadable ? <p className="text-sm leading-6 text-slate-600">The team starts could not be read, so no team is shown.</p> : null}
          {data.onLeaveAllWindow.length > 0 ? (
            <p className="break-words text-sm leading-6 text-slate-600">
              On approved leave for the whole window, so absent here without having moved: {data.onLeaveAllWindow.join(", ")}.
            </p>
          ) : null}
          {data.report.rowsOutsideThisList > 0 ? (
            <p className="text-sm leading-6 text-slate-600">
              {data.report.rowsOutsideThisList} iReports360 record(s) name nobody on the employee directory yet, so they are outside this list.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
