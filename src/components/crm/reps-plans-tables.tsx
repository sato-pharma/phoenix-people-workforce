"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import { SortableTh, SortButton, TableSearchInput, type SortState } from "@/components/ui/sortable-table";
import { useSortableTable } from "@/components/ui/use-sortable-table";
import { splitCrmRepName } from "@/lib/crm/rep-name";
import type { RepsPlansRepRow } from "@/lib/crm/reps-plans";

// Client half of Reps Plans. Styling copies the CRM coverage tables verbatim
// (brick-coverage-tables.tsx), its neighbour in the same shell — flat borders, slate-900 header
// rows, orange focus — because these boards answer the same kind of question about the same reps
// and one must not read as a one-off (owner's standing rule).
//
// The original was rep-doctor-lists-tables.tsx, deleted on 2026-09-02 as unreachable code. Same
// lineage, same look; brick-coverage-tables.tsx is the live copy of it.
//
// Month and rep ride in the URL, so every change re-runs the server-side access gate rather than
// filtering a payload already in the browser.
//
// Desktop table / mobile cards via PortalResponsiveDataList — AGENTS.md §4.
//
// THE DESKTOP TABLE FITS THE SCREEN. It was 13 columns over a 1700px floor inside an
// `overflow-x-auto` container until 2026-09-03, which is the owner's golden rule stated backwards:
// never a horizontal scroll, mobile AND desktop friendly, and `overflow-x-auto` over a min-width IS
// the bug rather than the fix. It is now `w-full table-fixed` with a `<colgroup>` and EIGHT columns,
// fitted the one permitted way — by MERGING columns, never by shrinking type and never by an
// ellipsis:
//
//   Rep            name, with the territory and role beneath it   (was 2 columns)
//   AM / PM        the proved rate with the reported one beneath  (was 2 x 2 columns)
//   AM% / PM%      attainment against the rep's own target
//   Unproven
//   Campaign       calls with the share beneath                   (was 2 columns)
//   Days           over the campaign limit, and with no proof     (was 2 columns)
//
// Nothing was dropped and nothing is sorted less finely: a merged cell carries two SortButtons
// (src/components/ui/sortable-table.tsx), which is why that control was split out of SortableTh.
// The rep name WRAPS — `whitespace-nowrap` moved off the row and onto the numeric cells only, so a
// long CRM handle grows the row's height instead of the page's width.

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";
const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400";

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

/** Grouped digits, same as every sibling CRM table. A rep's own counts stay small, but the card
 *  meta line carries the period's reported total, which does not. */
function count(value: number): string {
  return value.toLocaleString();
}

/**
 * `aria-sort` for a header cell carrying MORE THAN ONE sort control.
 *
 * SortableTh sets its own from its single key; a merged column cannot, because the attribute belongs
 * to the cell and the cell now holds two buttons. Whichever of the keys is active is the one the
 * table is actually sorted by, so that is the one a screen reader is told about — and when neither
 * is, the answer is "none" rather than nothing, which is what a table with no sort applied to this
 * column means.
 */
function ariaSortOf(sort: SortState | null, ...keys: string[]): "ascending" | "descending" | "none" {
  if (!sort || !keys.includes(sort.key)) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

export function RepsPlansControls({
  appliedLine,
  appliedRegion,
  appliedRepKey,
  basePath,
  geographyAvailable,
  lineOptions,
  month,
  periodKey,
  regionOptions,
  repOptions,
  weekOptions,
}: {
  appliedLine: string | null;
  appliedRegion: string | null;
  appliedRepKey: string | null;
  basePath: string;
  geographyAvailable: boolean;
  lineOptions: Array<{ code: string; name: string }>;
  month: string;
  periodKey: string;
  regionOptions: Array<{ code: string; name: string }>;
  repOptions: Array<{ repKey: string; repName: string }>;
  weekOptions: Array<{ key: string; label: string; workingDays: number; started: boolean }>;
}) {
  const router = useRouter();
  const custom = periodKey.includes("..");
  const [draft, setDraft] = useState({
    line: appliedLine ?? "",
    month,
    period: periodKey,
    region: appliedRegion ?? "",
    rep: appliedRepKey ?? "",
  });
  // The two ends of a custom window, edited independently — so "two weeks" is typed as two dates
  // rather than assembled out of week buttons that only ever offer seven days at a time.
  const [span, setSpan] = useState(() => {
    const parts = custom ? periodKey.split("..") : [];
    return { from: parts[0] ?? "", to: parts[1] ?? "" };
  });

  // Every filter moves TOGETHER. Pushing `?month=` on its own silently dropped the active rep on
  // the sibling board, which read as the filter having been ignored.
  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.period && next.period !== "month") params.set("period", next.period);
    if (next.line) params.set("line", next.line);
    if (next.region) params.set("region", next.region);
    if (next.rep) params.set("rep", next.rep);
    router.push(`${basePath}?${params.toString()}`);
  };

  const active = Boolean(draft.line || draft.region || draft.rep || (draft.period && draft.period !== "month"));

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <label className="space-y-1">
        <span className={LABEL_CLASS}>Month</span>
        <input
          className={SELECT_CLASS}
          onChange={(event) => {
            // A new month invalidates whatever week was chosen — "week 3" of one month is not a
            // window in another, and a custom span is anchored to real dates in the old one.
            const next = { ...draft, month: event.target.value, period: "month" };
            setDraft(next);
            if (event.target.value) push(next);
          }}
          type="month"
          value={draft.month}
        />
      </label>

      {/* THE WINDOW. Owner, 2026-08-28: the rate must be read over the period being looked at, not
          over a whole month — a week's calls divided by a month's working days shows every rep
          failing by a factor of four. Each week carries the number of days it would divide by,
          because a 5-day block and a 3-day tail are not the same denominator and the reader should
          not have to work that out. */}
      <label className="space-y-1">
        <span className={LABEL_CLASS}>Period</span>
        <select
          className={SELECT_CLASS}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "custom") {
              setDraft({ ...draft, period: "custom" });
              return;
            }
            const next = { ...draft, period: value };
            setDraft(next);
            push(next);
          }}
          value={custom || draft.period === "custom" ? "custom" : draft.period}
        >
          <option value="month">Whole month</option>
          {weekOptions.map((option) => (
            <option key={option.key} value={option.key}>
              {option.started ? `${option.label} · ${option.workingDays} days` : `${option.label} · not started`}
            </option>
          ))}
          <option value="custom">Custom dates</option>
        </select>
      </label>

      {/* Shown only once Custom is chosen, so the common case stays one dropdown. Both dates must be
          present and in order before anything is pushed — a half-typed range would otherwise reload
          the board against a window the reader has not finished describing. */}
      {custom || draft.period === "custom" ? (
        <label className="space-y-1">
          <span className={LABEL_CLASS}>From &amp; to</span>
          <div className="flex gap-1">
            {(["from", "to"] as const).map((end) => (
              <input
                className={SELECT_CLASS}
                key={end}
                onChange={(event) => {
                  const nextSpan = { ...span, [end]: event.target.value };
                  setSpan(nextSpan);
                  if (nextSpan.from && nextSpan.to && nextSpan.from <= nextSpan.to) {
                    const next = { ...draft, period: `${nextSpan.from}..${nextSpan.to}` };
                    setDraft(next);
                    push(next);
                  }
                }}
                type="date"
                value={span[end]}
              />
            ))}
          </div>
        </label>
      ) : null}

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
            const cleared = { line: "", month: draft.month, period: "month", region: "", rep: "" };
            setDraft(cleared);
            setSpan({ from: "", to: "" });
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

/**
 * What this person IS: his seat if the organogram has one, else his HR job title.
 *
 * The order matters. The organogram is the owner's own chart and outranks a free-text HR title for
 * anyone on it. But `au_v_org_tree` is the SALES seat model, so head office is off it by design —
 * every Product Manager in production included — and calling a Product Manager "Not in organogram"
 * is how the first build of this board managed to insult thirteen District Managers and a PM in one
 * screen. The marker is the LAST answer, for someone neither chart nor directory can place.
 */
function roleText(row: RepsPlansRepRow): string {
  return row.seatTierLabel ?? row.jobTitle ?? NOT_PLACED;
}

/** Said once, so the column, the search, the export and the card cannot drift apart on the wording. */
const NOT_PLACED = "Not in organogram";

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
  // Sorts the people with no territory together rather than scattering them: an empty cell sorts as
  // whatever the cell actually SHOWS — the job title, or the marker — so "Product Manager" lands
  // beside the other head-office rows instead of at both ends of the alphabet.
  {
    accessor: (r: RepsPlansRepRow) => territoryText(r) || roleText(r),
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
  appliedLine,
  appliedRegion,
  basePath,
  campaignLimit,
  geographyAvailable,
  month,
  monthLabel,
  periodKey,
  rows,
  scoredThrough,
}: {
  /** Carried into the drill-down so Back returns to the board the reader was actually reading. */
  appliedLine: string | null;
  appliedRegion: string | null;
  basePath: string;
  month: string;
  /** The window in force, carried into the drill-down for exactly the same reason. */
  periodKey: string;
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
  /**
   * The drill-down for one row: the visits this rate is made of.
   *
   * Keyed on the board's OWN `repKey`, url-encoded — "crm:2103" becomes "crm%3A2103". Deliberately
   * not a second identity scheme keyed on hr id: 3 of the 93 people on this board in August had no
   * resolved hr id at all, and a link that silently pointed at the wrong person — or at nobody —
   * would be worse than no link.
   */
  const visitsHref = (row: RepsPlansRepRow): string => {
    const query = new URLSearchParams({ month });
    // The window travels WITH the link. Opening a rep from a one-week board and landing on his whole
    // month is the same misreading the picker exists to prevent, one click further in.
    if (periodKey && periodKey !== "month") query.set("period", periodKey);
    if (appliedLine) query.set("line", appliedLine);
    if (appliedRegion) query.set("region", appliedRegion);
    return `${basePath}/${encodeURIComponent(row.repKey)}?${query.toString()}`;
  };

  const table = useSortableTable(rows, {
    columns: REP_COLS,
    // Opens on the worst PM attainment, because PM is ten of the twelve calls a perfect day is made
    // of — a rep short there is short on the month whatever the AM column says.
    initialSort: { dir: "asc", key: "pmAttainmentPct" },
    // Line · Region is searchable so "CNS" or "Delta" narrows the table without touching the
    // pickers — and so is the role, so "District Manager" lists the managers and "Product Manager"
    // lists head office.
    searchAccessors: geographyAvailable
      ? [(r) => r.repName, (r) => r.agentHrId ?? "", (r) => territoryText(r) || roleText(r), (r) => roleText(r)]
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
    // The export must match the screen (owner's standing rule) — a file that silently dropped the
    // territory column would read as though every rep had one.
    territory: territoryText(row) || roleText(row),
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
            meta={`${cardTerritory ? `${cardTerritory} · ` : ""}${count(row.workingDays)} working days · ${count(row.reportedCalls)} calls reported, ${count(row.verifiedCalls)} proved`}
            // Both rates sit in the badge, labelled. Neither answers the owner's question alone: AM
            // is the two accounts, PM is the ten clinics, and a rep can clear one and miss the other.
            status={
              <span className="flex items-start gap-3">
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${targetText(row, row.am.attainmentPct)}`}>
                    {rate(row.am.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-phx-4xs font-black uppercase tracking-[0.12em] text-slate-400">
                    {row.scored ? `AM of ${row.am.target}` : "AM rate"}
                  </span>
                </span>
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${targetText(row, row.pm.attainmentPct)}`}>
                    {rate(row.pm.verifiedRate)}
                  </span>
                  <span className="whitespace-nowrap text-phx-4xs font-black uppercase tracking-[0.12em] text-slate-400">
                    {row.scored ? `PM of ${row.pm.target}` : "PM rate"}
                  </span>
                </span>
              </span>
            }
            // Same drill-down as the desktop name cell. The card title is the only tap target a
            // phone has for this row, so the link goes ON it rather than on a separate control that
            // would cost a line of the card's scarcest space.
            title={
              <Link className="hover:text-orange-600 hover:underline" href={visitsHref(row)}>
                {cardTitle}
              </Link>
            }
          >
            <PortalRecordFields
              fields={[
                ...(geographyAvailable
                  ? [
                      {
                        label: "Line · Region",
                        value:
                          row.territories.length === 0 ? (
                            // Slate when the directory can say what he is — head office is not an
                            // exception to chase — and amber only for someone nothing can place.
                            <span
                              className={
                                row.jobTitle
                                  ? "border border-slate-300 bg-slate-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600"
                                  : "border border-amber-300 bg-amber-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700"
                              }
                            >
                              {row.jobTitle ?? NOT_PLACED}
                            </span>
                          ) : (
                            <span className="text-slate-500">{territoryText(row)}</span>
                          ),
                      },
                    ]
                  : []),
                // Only for a NON-rep, and only when the field above is showing a TERRITORY rather
                // than this same job title. On the 69 rep cards this row would say "Medical Rep"
                // under a heading that already says reps; on a head-office card it would print
                // "Product Manager" twice in two stacked rows, which is the phone's scarcest space
                // spent saying nothing. A District Manager still gets both, because they differ.
                ...(row.scored || (geographyAvailable && row.territories.length === 0)
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
                      <span className={row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}>{count(row.campaignCalls)}</span>
                      <span className="text-slate-300"> · </span>
                      <span className="text-slate-500">{row.campaignSharePct}%</span>
                    </span>
                  ),
                },
                {
                  label: `Days over ${campaignLimit}`,
                  value: <span className={row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}>{count(row.flaggedDays)}</span>,
                },
                {
                  label: "Days with no proof",
                  value: (
                    <span className={row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}>
                      {count(row.campaignOnlyDays)}
                    </span>
                  ),
                },
              ]}
            />
          </PortalRecordCard>
          );
        }}
        renderTable={() => (
          // NOT PortalDesktopTable. That primitive is an `overflow-x-auto` wrapper around a
          // min-width floor, which is precisely the shape the owner's golden rule forbids — a board
          // bound by it renders its own `w-full table-fixed` with a `<colgroup>` instead. The
          // `hidden md:block` is the half of the primitive that is still wanted: below md this list
          // renders the cards above, not a squeezed table.
          <div className="hidden md:block">
            <table className="w-full table-fixed border-collapse text-left text-xs">
              {/* The eight widths add to exactly 100, so the table can never want more room than it
                  has. Rep takes a quarter because it is the only column holding prose — a CRM handle
                  is a login name with a territory bolted on, and it is the one thing here allowed to
                  wrap onto a second line. */}
              <colgroup>
                <col style={{ width: "24%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "11%" }} />
              </colgroup>
              <thead>
                {/* Two header rows: the session groups above, the measures below. AM and PM are
                    different KPIs against different targets, and a single flat row of headings
                    invites reading a PM figure against the AM target. */}
                <tr className="bg-slate-900 text-left">
                  <th className={THEAD} rowSpan={2} scope="col">
                    Rep
                  </th>
                  <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={2} scope="colgroup">
                    AM — target 2 / day
                  </th>
                  <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={2} scope="colgroup">
                    PM — target 10 / day
                  </th>
                  <th className={`${THEAD} border-l border-slate-700 text-center`} colSpan={3} scope="colgroup">
                    Proof
                  </th>
                </tr>
                <tr className="bg-slate-900 text-left">
                  {/* PROVED over REPORTED, in one cell and in that order — the proved rate is the
                      headline and the reported one is what it is being compared against. Both stay
                      independently sortable: a column that merged two measures into one sort key
                      would have quietly deleted a way of reading the board. */}
                  <th
                    aria-sort={ariaSortOf(table.sort, "amVerifiedRate", "amReportedRate")}
                    className={`${THEAD} border-l border-slate-700 text-right`}
                    scope="col"
                  >
                    <span className="flex flex-col items-end gap-0.5">
                      <SortButton
                        align="right"
                        className="text-emerald-300"
                        label="Proved"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="amVerifiedRate"
                      />
                      <SortButton
                        align="right"
                        className="text-phx-3xs font-bold normal-case tracking-normal text-slate-400"
                        label="reported"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="amReportedRate"
                      />
                    </span>
                  </th>
                  <SortableTh
                    align="right"
                    className={`${THEAD} text-right`}
                    label="% Target"
                    onSort={table.toggleSort}
                    sort={table.sort}
                    sortKey="amAttainmentPct"
                  />
                  <th
                    aria-sort={ariaSortOf(table.sort, "pmVerifiedRate", "pmReportedRate")}
                    className={`${THEAD} border-l border-slate-700 text-right`}
                    scope="col"
                  >
                    <span className="flex flex-col items-end gap-0.5">
                      <SortButton
                        align="right"
                        className="text-emerald-300"
                        label="Proved"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="pmVerifiedRate"
                      />
                      <SortButton
                        align="right"
                        className="text-phx-3xs font-bold normal-case tracking-normal text-slate-400"
                        label="reported"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="pmReportedRate"
                      />
                    </span>
                  </th>
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
                  <th
                    aria-sort={ariaSortOf(table.sort, "campaignCalls", "campaignSharePct")}
                    className={`${THEAD} text-right`}
                    scope="col"
                  >
                    <span className="flex flex-col items-end gap-0.5">
                      <SortButton
                        align="right"
                        className="text-sky-300"
                        label="Campaign"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="campaignCalls"
                      />
                      <SortButton
                        align="right"
                        className="text-phx-3xs font-bold normal-case tracking-normal text-sky-200"
                        label="share"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="campaignSharePct"
                      />
                    </span>
                  </th>
                  {/* The two DAY counts read together — a day over the campaign limit and a day with
                      no proof at all are the same question asked twice, and neither is meaningful
                      without the other. */}
                  <th
                    aria-sort={ariaSortOf(table.sort, "flaggedDays", "campaignOnlyDays")}
                    className={`${THEAD} text-right`}
                    scope="col"
                  >
                    <span className="flex flex-col items-end gap-0.5">
                      <SortButton
                        align="right"
                        className="text-rose-300"
                        label={`Over ${campaignLimit}`}
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="flaggedDays"
                      />
                      <SortButton
                        align="right"
                        className="text-phx-3xs font-bold normal-case tracking-normal text-amber-300"
                        label="no proof"
                        onSort={table.toggleSort}
                        sort={table.sort}
                        sortKey="campaignOnlyDays"
                      />
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {table.rows.map((row) => (
                  <tr className="bg-white align-top hover:bg-slate-50" key={row.repKey}>
                    {/* The name is the way IN. Every figure on this row is an aggregate, and the one
                        question a manager asks of an aggregate is "made of what" — so the rep opens
                        his own visits rather than the row being a dead end.

                        Line · Region from the ORGANOGRAM rides in this same cell, every tier — a DM,
                        an RSM and an NSM each resolve here exactly as a rep does. Someone with no
                        seat is kept on the board rather than filtered away and named by his HR job
                        title instead: `au_v_org_tree` is the SALES seat model, so a Product Manager
                        is off it BY DESIGN and "not in organogram" would be an accusation dressed as
                        a fact. Amber is kept for the one case that really is a gap — nobody,
                        anywhere, can say what this person is.

                        The tier is shown only for a NON-rep, so it costs nothing on the rows where
                        "Medical Rep" would just repeat what the page is about — and it is what
                        explains the blank percentages further along the row. */}
                    <td className="px-3 py-2 font-semibold text-slate-900">
                      <Link className="hover:text-orange-600 hover:underline" href={visitsHref(row)}>
                        {row.repName}
                      </Link>
                      {geographyAvailable ? (
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          {row.territories.length === 0 ? (
                            <span
                              className={
                                row.jobTitle
                                  ? "border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-slate-600"
                                  : "border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-amber-700"
                              }
                            >
                              {row.jobTitle ?? NOT_PLACED}
                            </span>
                          ) : (
                            <>
                              <span className="text-phx-3xs font-semibold text-slate-500">{territoryText(row)}</span>
                              {row.scored ? null : (
                                <span className="border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-phx-3xs font-black uppercase tracking-[0.08em] text-slate-600">
                                  {roleText(row)}
                                </span>
                              )}
                            </>
                          )}
                        </span>
                      ) : null}
                    </td>
                    {/* A manager keeps his real rates — his account appears, exactly as asked — but
                        is coloured and scored against nothing. */}
                    <td className="whitespace-nowrap border-l border-slate-100 px-2 py-2 text-right">
                      <span className={`block font-black tabular-nums ${targetText(row, row.am.attainmentPct)}`}>
                        {rate(row.am.verifiedRate)}
                      </span>
                      <span className="block text-phx-3xs font-semibold tabular-nums text-slate-400">
                        {rate(row.am.reportedRate)} rep.
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums ${targetText(row, row.am.attainmentPct)}`}
                    >
                      {targetPct(row, row.am.attainmentPct)}
                    </td>
                    <td className="whitespace-nowrap border-l border-slate-100 px-2 py-2 text-right">
                      <span className={`block font-black tabular-nums ${targetText(row, row.pm.attainmentPct)}`}>
                        {rate(row.pm.verifiedRate)}
                      </span>
                      <span className="block text-phx-3xs font-semibold tabular-nums text-slate-400">
                        {rate(row.pm.reportedRate)} rep.
                      </span>
                    </td>
                    <td
                      className={`whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums ${targetText(row, row.pm.attainmentPct)}`}
                    >
                      {targetPct(row, row.pm.attainmentPct)}
                    </td>
                    <td
                      className={`whitespace-nowrap border-l border-slate-100 px-2 py-2 text-right font-bold tabular-nums ${unprovenText(row.unprovenPct)}`}
                    >
                      {pct(row.unprovenPct)}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <span
                        className={`block font-bold tabular-nums ${row.campaignCalls > 0 ? "text-sky-700" : "text-slate-400"}`}
                      >
                        {count(row.campaignCalls)}
                      </span>
                      <span
                        className={`block text-phx-3xs font-semibold tabular-nums ${row.campaignSharePct >= 50 ? "text-sky-700" : "text-slate-400"}`}
                      >
                        {row.campaignSharePct}%
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <span
                        className={`block font-bold tabular-nums ${row.flaggedDays > 0 ? "text-rose-700" : "text-slate-400"}`}
                      >
                        {count(row.flaggedDays)}
                      </span>
                      <span
                        className={`block text-phx-3xs font-semibold tabular-nums ${row.campaignOnlyDays > 0 ? "text-amber-700" : "text-slate-400"}`}
                      >
                        {count(row.campaignOnlyDays)} np
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      />
    </div>
  );
}
