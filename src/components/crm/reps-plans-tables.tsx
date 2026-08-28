"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, TableSearchInput } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import { splitCrmRepName } from "@/lib/crm/rep-name";
import type { RepsPlansRepRow } from "@/lib/crm/reps-plans";

// Client half of Reps Plans. Styling copies the Rep Doctor Lists tables verbatim
// (rep-doctor-lists-tables.tsx), its neighbour in the same shell — flat borders, slate-900 header
// rows, orange focus — because the two boards answer the same question about the same reps and one
// must not read as a one-off (owner's standing rule).
//
// Month and rep ride in the URL, so every change re-runs the server-side access gate rather than
// filtering a payload already in the browser.
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4. Nothing here wraps or
// ellipsises: rows are `whitespace-nowrap` and the table scrolls inside its own container.

const THEAD = "px-3 py-2.5 text-[10px] font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400";

/** Attainment against the rep's own target. 100% is the standard, not a stretch. */
function attainmentText(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 100) return "text-emerald-700";
  if (pct >= 70) return "text-amber-700";
  return "text-rose-700";
}

function attainmentAccent(pct: number | null): "emerald" | "amber" | "rose" | "slate" {
  if (pct == null) return "slate";
  if (pct >= 100) return "emerald";
  if (pct >= 70) return "amber";
  return "rose";
}

/** Unproven runs the other way — a high share is the problem, not the achievement. */
function unprovenText(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct >= 50) return "text-rose-700";
  if (pct >= 25) return "text-amber-700";
  return "text-emerald-700";
}

/** Rates print to 2 decimals so 1.96 never rounds up into a target it did not reach. */
function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

function pct(value: number | null): string {
  return value == null ? "—" : `${value}%`;
}

export function RepsPlansControls({
  appliedLine,
  appliedRegion,
  appliedRepKey,
  basePath,
  geographyAvailable,
  lineOptions,
  month,
  regionOptions,
  repOptions,
}: {
  appliedLine: string | null;
  appliedRegion: string | null;
  appliedRepKey: string | null;
  basePath: string;
  geographyAvailable: boolean;
  lineOptions: Array<{ code: string; name: string }>;
  month: string;
  regionOptions: Array<{ code: string; name: string }>;
  repOptions: Array<{ repKey: string; repName: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    line: appliedLine ?? "",
    month,
    region: appliedRegion ?? "",
    rep: appliedRepKey ?? "",
  });

  // Every filter moves TOGETHER. Pushing `?month=` on its own silently dropped the active rep on
  // the sibling board, which read as the filter having been ignored.
  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.line) params.set("line", next.line);
    if (next.region) params.set("region", next.region);
    if (next.rep) params.set("rep", next.rep);
    router.push(`${basePath}?${params.toString()}`);
  };

  const active = Boolean(draft.line || draft.region || draft.rep);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      <label className="space-y-1">
        <span className={LABEL_CLASS}>Month</span>
        <input
          className={SELECT_CLASS}
          onChange={(event) => {
            const next = { ...draft, month: event.target.value };
            setDraft(next);
            if (event.target.value) push(next);
          }}
          type="month"
          value={draft.month}
        />
      </label>

      {/* LINE then REGION, in that order — the owner's own cascade. Region is narrowed by the line
          above it because Beni Suef and Fayoum sit in different regions depending on the line, so
          the reverse order offers a pairing no rep satisfies. Changing the line therefore CLEARS
          the region rather than leaving a combination the dropdowns never offered. Both pickers are
          hidden outright when the org model could not be read — an empty picker reads as "no lines
          exist", which would be a lie. */}
      {geographyAvailable ? (
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Line</span>
          <select
            className={SELECT_CLASS}
            onChange={(event) => {
              const next = { ...draft, line: event.target.value, region: "" };
              setDraft(next);
              push(next);
            }}
            value={draft.line}
          >
            <option value="">All lines</option>
            {lineOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {geographyAvailable ? (
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Region</span>
          <select
            className={SELECT_CLASS}
            onChange={(event) => {
              const next = { ...draft, region: event.target.value };
              setDraft(next);
              push(next);
            }}
            value={draft.region}
          >
            <option value="">All regions</option>
            {regionOptions.map((option) => (
              <option key={option.code} value={option.code}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="space-y-1">
        <span className={LABEL_CLASS}>Rep</span>
        <select
          className={SELECT_CLASS}
          onChange={(event) => {
            const next = { ...draft, rep: event.target.value };
            setDraft(next);
            push(next);
          }}
          value={draft.rep}
        >
          <option value="">All reps</option>
          {repOptions.map((option) => (
            <option key={option.repKey} value={option.repKey}>
              {option.repName}
            </option>
          ))}
        </select>
      </label>

      <div className="space-y-1">
        <span className={LABEL_CLASS}>&nbsp;</span>
        <button
          className="h-9 w-full border border-slate-200 bg-white px-3 text-xs font-black uppercase tracking-[0.1em] text-slate-500 hover:border-orange-400 hover:text-orange-600 disabled:opacity-40"
          disabled={!active}
          onClick={() => {
            const cleared = { line: "", month: draft.month, region: "", rep: "" };
            setDraft(cleared);
            push(cleared);
          }}
          type="button"
        >
          Clear
        </button>
      </div>
    </div>
  );
}

/** "CNS · Delta (1)", or every pair when a person covers more than one — an NSM covers seven. */
function territoryText(row: RepsPlansRepRow): string {
  return row.territories.map((t) => `${t.lineName} · ${t.regionName}`).join("  |  ");
}

/** "District Manager", or the honest answer when the organogram has no seat for him. */
function roleText(row: RepsPlansRepRow): string {
  return row.seatTierLabel ?? "Not in organogram";
}

/**
 * THE OWNER'S RULE, 2026-08-28: the 2 AM / 10 PM target is a MEDICAL REP'S.
 *
 * A manager keeps his real rates on the row — that is his account appearing, which is what was
 * asked for — but his percentage OF TARGET is blank and uncoloured, because there is no target to
 * be a percentage of. Printing a red 12% beside a District Manager measures him against a job that
 * is not his.
 */
function targetPct(row: RepsPlansRepRow, value: number | null): string {
  return row.scored ? pct(value) : "—";
}
function targetText(row: RepsPlansRepRow, value: number | null): string {
  return row.scored ? attainmentText(value) : "text-slate-300";
}

const REP_COLS = [
  { accessor: (r: RepsPlansRepRow) => r.repName, defaultDir: "asc" as const, key: "repName", type: "string" as const },
  // NOT called "Territory", deliberately. The Rep column beside it already ends in the CRM handle's
  // own bracket — "( Down-town / C )", an AREA and a line letter — so a second column called
  // territory would put the line on the row twice under two names. This column is the org model's
  // LINE and REGION, which is what the two pickers above filter on, and it says so.
  //
  // Sorts the marked people together rather than scattering them: an empty cell sorts as the marker
  // text, so "Not in organogram" lands in one block instead of at both ends of the alphabet.
  {
    accessor: (r: RepsPlansRepRow) => territoryText(r) || "Not in organogram",
    defaultDir: "asc" as const,
    key: "territory",
    type: "string" as const,
  },
  { accessor: (r: RepsPlansRepRow) => r.am.verifiedRate, key: "amVerifiedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.am.reportedRate, key: "amReportedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.am.attainmentPct, key: "amAttainmentPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.verifiedRate, key: "pmVerifiedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.reportedRate, key: "pmReportedRate", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.pm.attainmentPct, key: "pmAttainmentPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.unprovenPct, key: "unprovenPct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignCalls, key: "campaignCalls", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignSharePct, key: "campaignSharePct", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.flaggedDays, key: "flaggedDays", type: "number" as const },
  { accessor: (r: RepsPlansRepRow) => r.campaignOnlyDays, key: "campaignOnlyDays", type: "number" as const },
];

export function RepsPlansRepTable({
  campaignLimit,
  geographyAvailable,
  monthLabel,
  rows,
  scoredThrough,
}: {
  campaignLimit: number;
  /**
   * False when the organogram could not be read.
   *
   * The whole Line · Region column then goes away rather than rendering "Not in organogram" against
   * every name on the page — that marker is a statement about a chart nobody managed to read, and
   * on 87 rows it would read as though the company had lost its org structure overnight.
   */
  geographyAvailable: boolean;
  monthLabel: string;
  rows: RepsPlansRepRow[];
  scoredThrough: string;
}) {
  const table = useSortableTable(rows, {
    columns: REP_COLS,
    // Opens on the worst PM attainment, because PM is ten of the twelve calls a perfect day is made
    // of — a rep short there is short on the month whatever the AM column says.
    initialSort: { dir: "asc", key: "pmAttainmentPct" },
    // Line · Region is searchable so "CNS" or "Delta" narrows the table without touching the
    // pickers — and so are the role and the marker, so "District Manager" lists the managers and
    // "Not in organogram" lists exactly the people with no seat.
    searchAccessors: geographyAvailable
      ? [(r) => r.repName, (r) => r.agentHrId ?? "", (r) => territoryText(r) || "Not in organogram", (r) => roleText(r)]
      : [(r) => r.repName, (r) => r.agentHrId ?? ""],
  });

  const exportRows = table.rows.map((row) => ({
    am_proved: row.am.verifiedRate,
    am_reported: row.am.reportedRate,
    am_pct: row.am.attainmentPct,
    campaign_calls: row.campaignCalls,
    campaign_only_days: row.campaignOnlyDays,
    campaign_share: row.campaignSharePct,
    flagged_days: row.flaggedDays,
    hr_id: row.agentHrId ?? "",
    pm_proved: row.pm.verifiedRate,
    pm_reported: row.pm.reportedRate,
    pm_pct: row.pm.attainmentPct,
    rep: row.repName,
    // The export must match the screen (owner's standing rule), marker included — a file that
    // silently dropped the territory column would read as though every rep had one.
    territory: territoryText(row) || "Not in organogram",
    // Exported so the file states WHY a manager row has no percentage — without it the reader of
    // the spreadsheet sees a blank and reads it as missing data rather than as "not his target".
    role: roleText(row),
    unproven: row.unprovenPct,
    unspecified: row.unspecified,
    working_days: row.workingDays,
  }));

  return (
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TableSearchInput onChange={table.setQuery} onClear={table.clearQuery} placeholder="Search rep…" value={table.query} />
        {/* The export carries BOTH rates. Shipping only the proved one would leave the reader of the
            file unable to see the gap this page exists to show, and shipping only the reported one
            would export the very number that cannot be trusted. */}
        <ExportXlsxButton
          columns={[
            { key: "rep", label: "Rep" },
            // The export must match the screen (owner's standing rule) — including when the
            // organogram is unreadable and the screen has no such column.
            ...(geographyAvailable
              ? [
                  { key: "territory", label: "Line · Region" },
                  { key: "role", label: "Role" },
                ]
              : []),
            { key: "hr_id", label: "HR ID" },
            { key: "working_days", label: "Working Days", numeric: true },
            { key: "am_proved", label: "AM Proved Rate", numeric: true },
            { key: "am_reported", label: "AM Reported Rate", numeric: true },
            { key: "am_pct", label: "AM % Of Target", numeric: true },
            { key: "pm_proved", label: "PM Proved Rate", numeric: true },
            { key: "pm_reported", label: "PM Reported Rate", numeric: true },
            { key: "pm_pct", label: "PM % Of Target", numeric: true },
            { key: "unproven", label: "Unproven %", numeric: true },
            { key: "campaign_calls", label: "Campaign Calls", numeric: true },
            { key: "campaign_share", label: "Campaign Share %", numeric: true },
            { key: "flagged_days", label: `Days Over ${campaignLimit}`, numeric: true },
            { key: "campaign_only_days", label: "Days With No Proof", numeric: true },
            { key: "unspecified", label: "No AM/PM Flag", numeric: true },
          ]}
          rows={exportRows}
          sheetName="Reps Plans"
          subtitle={`${monthLabel} · scored through ${scoredThrough}`}
          title="Reps Plans — split call rate by rep"
        />
      </div>

      <PortalResponsiveDataList
        empty={
          <p className="px-3 py-6 text-center text-xs text-slate-400">
            No rep recorded field work in this period.
          </p>
        }
        getKey={(row) => row.repKey}
        items={table.rows}
        renderCard={(row) => {
          // The CRM's agent_name is a login handle with the territory bolted on the end. The card
          // title WRAPS below md and must keep doing so — #2268 chose that over nowrap (which took
          // a 375px page to 455px of sideways scroll) and over an ellipsis. So the way to stop a
          // name wrapping is to stop the string being long: the person goes in the title, the
          // territory drops one line to the meta, and nothing is lost from the card.
          const { name, territory } = splitCrmRepName(row.repName);
          // A handle that is territory and NOTHING else has no person half. Show what there is
          // rather than an empty heading — and then do not repeat it on the meta line.
          const cardTitle = name || territory || row.repName;
          const cardTerritory = name ? territory : null;
          return (
          <PortalRecordCard
            // Unscored rows carry no verdict colour — the accent is a judgement against the target,
            // and a manager is measured against none.
            accent={row.scored ? attainmentAccent(row.pm.attainmentPct) : "slate"}
            meta={`${cardTerritory ? `${cardTerritory} · ` : ""}${row.workingDays} working days · ${row.reportedCalls} calls reported, ${row.verifiedCalls} proved`}
            // Both rates sit in the badge, labelled. Neither answers the owner's question alone: AM
            // is the two accounts, PM is the ten clinics, and a rep can clear one and miss the other.
            status={
              <span className="flex items-start gap-3">
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${targetText(row, row.am.attainmentPct)}`}>
                    {rate(row.am.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                    {row.scored ? `AM of ${row.am.target}` : "AM rate"}
                  </span>
                </span>
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${targetText(row, row.pm.attainmentPct)}`}>
                    {rate(row.pm.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-[8px] font-black uppercase tracking-[0.12em] text-slate-400">
                    {row.scored ? `PM of ${row.pm.target}` : "PM rate"}
                  </span>
                </span>
              </span>
            }
            title={cardTitle}
          >
            <PortalRecordFields
              fields={[
                ...(geographyAvailable
                  ? [
                      {
                        label: "Line · Region",
                        value:
                          row.territories.length === 0 ? (
                            <span className="border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-amber-700">
                              Not in organogram
                            </span>
                          ) : (
                            <span className="text-slate-500">{territoryText(row)}</span>
                          ),
                      },
                    ]
                  : []),
                // Only for a NON-rep. On the 71 rep cards this row would say "Medical Rep" under a
                // heading that already says reps, and the phone has the least room of anything here.
                ...(row.scored
                  ? []
                  : [
                      {
                        label: "Role",
                        value: <span className="font-semibold text-slate-600">{roleText(row)}</span>,
                      },
                    ]),
                {
                  label: "AM reported",
                  value: <span className="whitespace-nowrap text-slate-500">{rate(row.am.reportedRate)}</span>,
                },
                {
                  label: "PM reported",
                  value: <span className="whitespace-nowrap text-slate-500">{rate(row.pm.reportedRate)}</span>,
                },
                {
                  label: "Unproven",
                  value: <span className={unprovenText(row.unprovenPct)}>{pct(row.unprovenPct)}</span>,
                },
                {
                  label: "Campaign",
                  value: (
                    <span className="whitespace-nowrap">
                      <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>{row.campaignCalls}</span>
                      <span className="text-slate-300"> · </span>
                      <span className="text-slate-500">{row.campaignSharePct}%</span>
                    </span>
                  ),
                },
                {
                  label: `Days over ${campaignLimit}`,
                  value: <span className={row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}>{row.flaggedDays}</span>,
                },
                {
                  label: "Days with no proof",
                  value: (
                    <span className={row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}>
                      {row.campaignOnlyDays}
                    </span>
                  ),
                },
              ]}
            />
          </PortalRecordCard>
          );
        }}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth="1700px">
            <thead>
              {/* Two header rows: the session groups above, the measures below. AM and PM are
                  different KPIs against different targets, and a single flat row of twelve headings
                  invites reading a PM figure against the AM target. */}
              <tr className="bg-slate-900 text-left">
                <th className={THEAD} rowSpan={2} scope="col">
                  Rep
                </th>
                {geographyAvailable ? (
                  <th className={THEAD} rowSpan={2} scope="col">
                    Line · Region
                  </th>
                ) : null}
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={3} scope="colgroup">
                  AM — target 2 / day
                </th>
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={3} scope="colgroup">
                  PM — target 10 / day
                </th>
                <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={5} scope="colgroup">
                  Proof
                </th>
              </tr>
              <tr className="bg-slate-900 text-left">
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-emerald-300`}
                  label="Proved"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amVerifiedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-slate-400`}
                  label="Reported"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amReportedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right`}
                  label="% Target"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="amAttainmentPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-emerald-300`}
                  label="Proved"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmVerifiedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-slate-400`}
                  label="Reported"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmReportedRate"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right`}
                  label="% Target"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="pmAttainmentPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} border-l border-slate-700 text-right text-rose-300`}
                  label="Unproven"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="unprovenPct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-sky-300`}
                  label="Campaign"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignCalls"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-sky-300`}
                  label="Campaign %"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignSharePct"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-rose-300`}
                  label={`Days Over ${campaignLimit}`}
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="flaggedDays"
                />
                <SortableTh
                  align="right"
                  className={`${THEAD} text-right text-amber-300`}
                  label="Days No Proof"
                  onSort={table.toggleSort}
                  sort={table.sort}
                  sortKey="campaignOnlyDays"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {table.rows.map((row) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={row.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{row.repName}</td>
                  {/* Line · Region from the ORGANOGRAM, every tier — a DM, an RSM and an NSM each
                      resolve here exactly as a rep does. Someone the organogram has no seat for is
                      kept on the board rather than filtered away (he is usually one of the
                      zero-proved ones) and marked in amber: a gap to close, not his failure.

                      The tier rides in the same cell rather than a column of its own. It is only
                      ever shown for a NON-rep, so it costs nothing on the 71 rows where "Medical
                      Rep" would just repeat what the page is already about — and it is what
                      explains the blank percentages two cells to the right. */}
                  {geographyAvailable ? (
                    <td className="px-3 py-2">
                      {row.territories.length === 0 ? (
                        <span className="border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-amber-700">
                          Not in organogram
                        </span>
                      ) : (
                        <span className="flex items-center gap-2">
                          <span className="font-semibold text-slate-500">{territoryText(row)}</span>
                          {row.scored ? null : (
                            <span className="border border-slate-300 bg-slate-50 px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.1em] text-slate-600">
                              {roleText(row)}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  ) : null}
                  {/* A manager keeps his real rates — his account appears, exactly as asked — but
                      is coloured and scored against nothing. */}
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-black ${targetText(row, row.am.attainmentPct)}`}>
                    {rate(row.am.verifiedRate)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">{rate(row.am.reportedRate)}</td>
                  <td className={`px-3 py-2 text-right font-bold ${targetText(row, row.am.attainmentPct)}`}>
                    {targetPct(row, row.am.attainmentPct)}
                  </td>
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-black ${targetText(row, row.pm.attainmentPct)}`}>
                    {rate(row.pm.verifiedRate)}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-400">{rate(row.pm.reportedRate)}</td>
                  <td className={`px-3 py-2 text-right font-bold ${targetText(row, row.pm.attainmentPct)}`}>
                    {targetPct(row, row.pm.attainmentPct)}
                  </td>
                  <td className={`border-l border-slate-100 px-3 py-2 text-right font-bold ${unprovenText(row.unprovenPct)}`}>
                    {pct(row.unprovenPct)}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}>
                    {row.campaignCalls}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${row.campaignSharePct >= 50 ? "text-sky-700" : "text-slate-400"}`}>
                    {row.campaignSharePct}%
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}`}>
                    {row.flaggedDays}
                  </td>
                  <td className={`px-3 py-2 text-right font-bold ${row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}`}>
                    {row.campaignOnlyDays}
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />
    </div>
  );
}
