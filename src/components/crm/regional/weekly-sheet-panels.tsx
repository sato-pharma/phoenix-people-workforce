import Link from "next/link";

import { KpiSection, KpiTile } from "@/components/crm/kpis-chrome";
import type { WeeklySheet, WeeklySheetRep } from "@/lib/crm/weekly-sheet";
import {
  WEEKLY_SHEET_ACCOUNT_STATE_LABEL,
  WEEKLY_SHEET_ACCOUNT_STATES,
  WEEKLY_SHEET_ATTENTION,
  WEEKLY_SHEET_ATTENTION_LABEL,
  WEEKLY_SHEET_SHOW,
  WEEKLY_SHEET_SHOW_LABEL,
  weeklySheetAccountBar,
  weeklySheetAccountsWord,
  weeklySheetAttention,
  weeklySheetAttentionCounts,
  weeklySheetAttentionEmptyLine,
  weeklySheetDepthLine,
  weeklySheetDistrictKey,
  weeklySheetExportHref,
  WEEKLY_SHEET_PATH,
  weeklySheetHref,
  weeklySheetListedSeats,
  weeklySheetMetCaption,
  weeklySheetNav,
  weeklySheetPosition,
  weeklySheetPositionLine,
  weeklySheetRepAnchor,
  weeklySheetRepsWord,
  weeklySheetShowCounts,
  weeklySheetSpecialityGapLine,
  weeklySheetTargetLine,
  weeklySheetTeamLine,
  weeklySheetTeamTotals,
  weeklySheetTotals,
  weeklySheetUnmeasuredLine,
  weeklySheetVerdictBar,
  weeklySheetVisitsWord,
  type WeeklySheetBarPart,
  type WeeklySheetShow,
} from "@/lib/crm/weekly-sheet-summary";
import { regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";

/**
 * The panels above the district sections on the Weekly Sheet (owner, 9 Nov 2026: the premium pass on My Team's
 * Reports). Server-rendered, no client state: the week and the filter are links, the export one more.
 *
 * Every figure comes from `weekly-sheet-summary.ts`, the arithmetic the sections below and the Excel file read, so a
 * panel can never disagree with its sections. The finish is the house one, as on Visits and District Managers'
 * Plans: flat colour, square corners, hairline borders — no gradient, glow or drop shadow (owner, 22 Oct 2026).
 */

export const LINK = "border border-slate-300 bg-white px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-slate-700 hover:bg-slate-50";
export const LINK_ON = "border border-slate-900 bg-slate-900 px-3 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-white";
export const LABEL = "text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500";

/**
 * The week, the targets and the filter. The week links keep the filter; "Next week" appears only once that week has
 * begun, so the screen never opens on a week of zeros still to come. Each filter carries its count of seats, and the
 * Excel file always holds every seat.
 */
export function WeeklySheetToolbar({
  basePath = WEEKLY_SHEET_PATH,
  sheet,
  show,
}: {
  /** The page the week and filter links stay on: the portal's, or the Super Admin's admin twin (2026-11-11). */
  basePath?: string;
  sheet: WeeklySheet;
  show: WeeklySheetShow;
}) {
  const counts = weeklySheetShowCounts(sheet);
  const nav = weeklySheetNav(sheet);
  return (
    <div className="grid gap-3 border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className="text-phx-md font-black text-slate-900">Week · {sheet.label}</p>
          <p className="text-phx-sm font-semibold text-slate-700">{weeklySheetPositionLine(weeklySheetPosition(sheet))}</p>
          <p className="text-phx-sm text-slate-500">{weeklySheetTargetLine()}</p>
          <p className="text-phx-sm text-slate-500">{weeklySheetDepthLine()}</p>
        </div>
        <a className={LINK} href={weeklySheetExportHref(sheet.weekStart)}>
          Download Excel
        </a>
      </div>
      <div className="grid gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Week</span>
          <Link className={LINK} href={weeklySheetHref(nav.previous, show, basePath)}>
            Previous week
          </Link>
          <Link className={LINK} href={weeklySheetHref(null, show, basePath)}>
            Last full week
          </Link>
          {nav.next ? (
            <Link className={LINK} href={weeklySheetHref(nav.next, show, basePath)}>
              Next week
            </Link>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Show</span>
          {WEEKLY_SHEET_SHOW.map((key) => (
            <Link aria-current={key === show ? "true" : undefined} className={key === show ? LINK_ON : LINK} href={weeklySheetHref(sheet.weekStart, key, basePath)} key={key}>
              {WEEKLY_SHEET_SHOW_LABEL[key]} · {counts[key]}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Five tiles: PM, AM, both targets, the accounts with 3 of each, and the pharmacies. */
export function WeeklySheetTiles({ sheet }: { sheet: WeeklySheet }) {
  const position = weeklySheetPosition(sheet);
  const totals = weeklySheetTeamTotals(sheet);
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <KpiTile caption={weeklySheetMetCaption(totals.pmByVerdict, totals.measured, position)} label="PM visits" value={`${totals.pm} of ${totals.pmTarget}`} />
      <KpiTile caption={weeklySheetMetCaption(totals.amByVerdict, totals.measured, position)} label="AM visits" value={`${totals.am} of ${totals.amTarget}`} />
      <KpiTile
        caption={weeklySheetUnmeasuredLine(totals) ?? (position === "current" ? "Graded once the week is over" : "Every seat is measured")}
        label="Both targets met"
        value={position === "ahead" ? "–" : `${totals.bothMet} of ${totals.measured}`}
      />
      <KpiTile
        caption={totals.byAccountState.no_doctors > 0 ? `${totals.byAccountState.no_doctors} with no doctors written` : `${weeklySheetAccountsWord(totals.accounts)} visited`}
        label="Accounts with 3 of each"
        value={`${totals.byAccountState.met} of ${totals.accounts}`}
      />
      <KpiTile
        caption={totals.waiting > 0 ? `${weeklySheetVisitsWord(totals.waiting)} waiting for validation, counted in no figure` : "No visit waiting for validation"}
        label="Pharmacies"
        value={String(totals.pharmacies)}
      />
    </div>
  );
}

/** One flat bar and its key. The key lists every part with its count, so the bar never has to carry words. */
function Bar<K extends string>({ label, parts, whole }: { label: string; parts: WeeklySheetBarPart<K>[]; whole: string }) {
  return (
    <div className="grid gap-2">
      <p className={LABEL}>
        {label} · {whole}
      </p>
      {parts.length === 0 ? (
        <p className="text-phx-sm text-slate-400">Nothing to show</p>
      ) : (
        <>
          <div aria-hidden className="flex h-3 w-full border border-slate-200 bg-slate-50">
            {parts.map((part) => (
              <span className={`h-full ${part.swatch}`} key={part.key} style={{ width: `${part.percent}%` }} />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {parts.map((part) => (
              <li className="flex items-center gap-1.5 text-phx-sm font-semibold tabular-nums text-slate-700" key={part.key}>
                <span aria-hidden className={`inline-block h-2.5 w-2.5 border border-slate-300 ${part.swatch}`} />
                {part.label} · {part.count}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Where the week stands: the measured reps by their PM and their AM verdict, and every AM account by its depth. */
export function WeeklySheetStandPanel({ sheet }: { sheet: WeeklySheet }) {
  const position = weeklySheetPosition(sheet);
  const totals = weeklySheetTeamTotals(sheet);
  if (totals.seats === 0) return null;
  const reps = weeklySheetRepsWord(totals.measured);
  return (
    <div className="border border-slate-200">
      <KpiSection description={weeklySheetTeamLine(totals, position)} title="Where the week stands">
        <div className="grid gap-px bg-slate-200 lg:grid-cols-3">
          <div className="bg-white p-4">
            <Bar label="PM against target" parts={position === "ahead" ? [] : weeklySheetVerdictBar(totals.pmByVerdict)} whole={reps} />
          </div>
          <div className="bg-white p-4">
            <Bar label="AM against target" parts={position === "ahead" ? [] : weeklySheetVerdictBar(totals.amByVerdict)} whole={reps} />
          </div>
          <div className="bg-white p-4">
            <Bar label="AM accounts by their doctors" parts={weeklySheetAccountBar(totals)} whole={weeklySheetAccountsWord(totals.accounts)} />
          </div>
        </div>
        {weeklySheetUnmeasuredLine(totals) ? <p className="border-t border-slate-200 px-4 py-2 text-phx-sm text-slate-500">{weeklySheetUnmeasuredLine(totals)}.</p> : null}
      </KpiSection>
    </div>
  );
}

/**
 * A quiet name link to a rep's row, only when that row is on the page under the filter. The row is a table row
 * from `md` and a card below it, so the link goes to whichever of the two is showing.
 */
function RepName({ listed, name, rep }: { listed: boolean; name: string; rep: Pick<WeeklySheetRep, "seatId"> }) {
  return listed ? (
    <>
      <a className="hidden break-words text-phx-md font-black text-slate-900 hover:underline md:inline" href={`#${weeklySheetRepAnchor(rep)}`}>
        {name}
      </a>
      <a className="break-words text-phx-md font-black text-slate-900 hover:underline md:hidden" href={`#${weeklySheetRepAnchor(rep, "card")}`}>
        {name}
      </a>
    </>
  ) : (
    <span className="break-words text-phx-md font-black text-slate-900">{name}</span>
  );
}

/** The reps to open first, every reason in words, with a count per reason above the list. */
export function WeeklySheetAttentionPanel({ sheet, show }: { sheet: WeeklySheet; show: WeeklySheetShow }) {
  const items = weeklySheetAttention(sheet);
  const counts = weeklySheetAttentionCounts(items);
  const listed = weeklySheetListedSeats(sheet, show);
  const position = weeklySheetPosition(sheet);
  if (sheet.districts.length === 0) return null;
  return (
    <div className="border border-slate-200">
      <KpiSection description={items.length > 0 ? `${weeklySheetRepsWord(items.length)} with something to look at` : weeklySheetAttentionEmptyLine(position)} title="Reps to look at">
        {items.length > 0 ? (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 border-b border-slate-200 px-4 py-2">
              {WEEKLY_SHEET_ATTENTION.filter((reason) => counts[reason] > 0).map((reason) => (
                <li className="text-phx-sm font-semibold tabular-nums text-slate-700" key={reason}>
                  {WEEKLY_SHEET_ATTENTION_LABEL[reason]} · {counts[reason]}
                </li>
              ))}
            </ul>
            <ul className="divide-y divide-slate-100">
              {items.map((item) => (
                <li className="grid gap-1 px-4 py-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-4" key={item.rep.seatId}>
                  <div className="min-w-0">
                    <RepName rep={item.rep} listed={listed.has(item.rep.seatId)} name={item.rep.person} />
                    <p className="break-words text-phx-sm text-slate-500">
                      {item.rep.territory} · {regionManagerTitle(item.district.regionName, item.district.managerName)}
                    </p>
                  </div>
                  <ul className="grid min-w-0 gap-0.5">
                    {item.reasons.map((entry) => (
                      <li className="break-words text-phx-sm font-semibold text-amber-800" key={entry.reason}>
                        {entry.words}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </KpiSection>
    </div>
  );
}

/** The doctors inside the AM accounts, district by district: how many accounts reach 3 of each, and what they lack. */
export function WeeklySheetAccountsPanel({ sheet }: { sheet: WeeklySheet }) {
  const position = weeklySheetPosition(sheet);
  const team = weeklySheetTeamTotals(sheet);
  if (team.accounts === 0) return null;
  const rows = sheet.districts.map((district) => ({ district, totals: weeklySheetTotals(district.reps, position) })).filter((row) => row.totals.accounts > 0);
  return (
    <div className="border border-slate-200">
      <KpiSection description={weeklySheetSpecialityGapLine(team) ?? "Every account with doctors written has 3 of each"} title="Doctors of each speciality">
        <table className="hidden w-full table-fixed text-left md:table">
          <colgroup>
            <col className="w-[27%]" />
            <col className="w-[13%]" />
            <col className="w-[12%]" />
            <col className="w-[15%]" />
            <col className="w-[13%]" />
            <col className="w-[20%]" />
          </colgroup>
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
              <th className="px-4 py-2">Region and district manager</th>
              <th className="px-2 py-2">Accounts</th>
              {WEEKLY_SHEET_ACCOUNT_STATES.map((state) => (
                <th className="px-2 py-2" key={state}>
                  {WEEKLY_SHEET_ACCOUNT_STATE_LABEL[state]}
                </th>
              ))}
              <th className="px-4 py-2">Short most often</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ district, totals }) => (
              <tr className="border-b border-slate-100 align-top text-phx-md last:border-b-0" key={weeklySheetDistrictKey(district)}>
                <td className="break-words px-4 py-2 font-semibold text-slate-900">{regionManagerTitle(district.regionName, district.managerName)}</td>
                <td className="px-2 py-2 tabular-nums">{totals.accounts}</td>
                {WEEKLY_SHEET_ACCOUNT_STATES.map((state) => (
                  <td className="px-2 py-2 tabular-nums" key={state}>
                    {totals.byAccountState[state]}
                  </td>
                ))}
                <td className="break-words px-4 py-2 text-phx-sm text-slate-600">{weeklySheetSpecialityGapLine(totals) ?? "None short"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="divide-y divide-slate-100 md:hidden">
          {rows.map(({ district, totals }) => (
            <li className="grid gap-1 px-4 py-3" key={weeklySheetDistrictKey(district)}>
              <p className="break-words text-phx-md font-black text-slate-900">{regionManagerTitle(district.regionName, district.managerName)}</p>
              <p className="text-phx-sm tabular-nums text-slate-700">
                {weeklySheetAccountsWord(totals.accounts)} ·{" "}
                {WEEKLY_SHEET_ACCOUNT_STATES.map((state) => `${WEEKLY_SHEET_ACCOUNT_STATE_LABEL[state]} ${totals.byAccountState[state]}`).join(" · ")}
              </p>
              <p className="break-words text-phx-sm text-slate-500">{weeklySheetSpecialityGapLine(totals) ?? "None short"}</p>
            </li>
          ))}
        </ul>
      </KpiSection>
    </div>
  );
}
