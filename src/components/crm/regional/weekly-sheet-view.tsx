import type { ReactNode } from "react";

import { KpiSection } from "@/components/crm/kpis-chrome";
import {
  WeeklySheetAccountsPanel,
  WeeklySheetAttentionPanel,
  WeeklySheetStandPanel,
  WeeklySheetTiles,
  WeeklySheetToolbar,
} from "@/components/crm/regional/weekly-sheet-panels";
import { DOCTOR_FAMILY_LABEL } from "@/lib/crm/account-doctor-notes";
import type { WeeklySheet, WeeklySheetAccount, WeeklySheetRep } from "@/lib/crm/weekly-sheet";
import {
  WEEKLY_SHEET_ACCOUNT_STATE_LABEL,
  WEEKLY_SHEET_FAMILIES,
  WEEKLY_SHEET_NO_DOCTORS,
  WEEKLY_SHEET_VERDICT_TONE,
  filterWeeklySheetDistricts,
  weeklySheetAccountShortLine,
  weeklySheetAccountState,
  weeklySheetAccountsInOrder,
  weeklySheetAccountsWord,
  weeklySheetDepthMet,
  weeklySheetDistrictKey,
  weeklySheetDistrictLine,
  weeklySheetGapWords,
  weeklySheetPosition,
  weeklySheetRepAnchor,
  weeklySheetRepDaysLine,
  weeklySheetRepVerdicts,
  weeklySheetShowEmptyLine,
  weeklySheetTotals,
  weeklySheetVerdict,
  weeklySheetVisitsWord,
  weeklySheetWaitingLine,
  type WeeklySheetAccountState,
  type WeeklySheetFamily,
  type WeeklySheetPosition,
  type WeeklySheetShow,
  type WeeklySheetVerdict,
} from "@/lib/crm/weekly-sheet-summary";
import { regionGroupCaption, regionManagerTitle } from "@/lib/phoenix-crm/region-manager-groups";

/**
 * The Weekly Sheet, the Regional Sales Manager's screen (owner, 2026-11-08; the premium pass, 9 Nov 2026).
 * Server-rendered. The panels on top read the whole team; then one section per region and district manager, a row
 * per rep, and each rep's AM accounts opening under the row (a plain disclosure, no client state). Desktop shows
 * tables, a phone shows cards.
 *
 * Every figure and every word of a grade comes from `weekly-sheet-summary.ts`. "Met" and "Below" are words, never a
 * colour alone; a week still running says "So far", never "Below"; a comment naming no doctor says so instead of a
 * zero; a rep with no AM account offers nothing to open.
 */

function Verdict({ verdict }: { verdict: WeeklySheetVerdict }) {
  return <span className={`border px-1.5 py-px text-phx-xs font-black uppercase tracking-wide ${WEEKLY_SHEET_VERDICT_TONE[verdict]}`}>{verdict}</span>;
}

const ACCOUNT_STATE_TONE: Record<WeeklySheetAccountState, string> = {
  met: "border-emerald-300 bg-emerald-50 text-emerald-800",
  no_doctors: "border-slate-200 bg-slate-50 text-slate-500",
  short: "border-amber-300 bg-amber-50 text-amber-800",
};

function AccountState({ account }: { account: WeeklySheetAccount }) {
  const state = weeklySheetAccountState(account.depth);
  return <span className={`border px-1.5 py-px text-phx-xs font-black uppercase tracking-wide ${ACCOUNT_STATE_TONE[state]}`}>{WEEKLY_SHEET_ACCOUNT_STATE_LABEL[state]}</span>;
}

/** One figure against its target: the count, the grade in words, and the gap when there is one. */
function Figure({ position, target, vacant, value }: { position: WeeklySheetPosition; target: number; vacant: boolean; value: number }) {
  const verdict = weeklySheetVerdict(value, target, vacant, position);
  const gap = weeklySheetGapWords(value, target, verdict);
  return (
    <span className="grid gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <span className="text-phx-md font-black tabular-nums text-slate-900">{vacant || target <= 0 ? value : `${value} of ${target}`}</span>
        <Verdict verdict={verdict} />
      </span>
      {gap ? <span className={`text-phx-xs font-semibold ${verdict === "Below" ? "text-amber-800" : "text-slate-500"}`}>{gap}</span> : null}
    </span>
  );
}

function Depth({ account, family }: { account: WeeklySheetAccount; family: WeeklySheetFamily }) {
  const value = account.depth[family];
  return <span className={`tabular-nums ${weeklySheetDepthMet(value) ? "font-black text-slate-900" : "font-semibold text-amber-800"}`}>{value}</span>;
}

function Accounts({ rep }: { rep: WeeklySheetRep }) {
  const accounts = weeklySheetAccountsInOrder(rep.accounts);
  return (
    <>
      <table className="hidden w-full table-fixed text-left md:table">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[8%]" />
          <col className="w-[12%]" />
          <col className="w-[17%]" />
          <col className="w-[8%]" />
          <col className="w-[25%]" />
        </colgroup>
        <thead>
          <tr className="border-y border-slate-200 bg-slate-50 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500">
            <th className="px-4 py-2">Account</th>
            <th className="px-2 py-2">Visits</th>
            {WEEKLY_SHEET_FAMILIES.map((family) => (
              <th className="px-2 py-2" key={family}>
                {DOCTOR_FAMILY_LABEL[family]}
              </th>
            ))}
            <th className="px-4 py-2">3 of each</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr className="border-b border-slate-100 align-top text-phx-md last:border-b-0" key={account.customerId}>
              <td className="break-words px-4 py-2 font-semibold text-slate-900" dir="auto">
                {account.name}
              </td>
              <td className="px-2 py-2 tabular-nums">{account.visits}</td>
              {account.depth.noDoctorsWritten ? (
                <td className="px-2 py-2 text-phx-sm font-semibold text-slate-500" colSpan={4}>
                  {WEEKLY_SHEET_NO_DOCTORS}
                </td>
              ) : (
                <>
                  {WEEKLY_SHEET_FAMILIES.map((family) => (
                    <td className="px-2 py-2" key={family}>
                      <Depth account={account} family={family} />
                    </td>
                  ))}
                  <td className="grid gap-1 px-4 py-2">
                    <span>
                      <AccountState account={account} />
                    </span>
                    {weeklySheetAccountShortLine(account.depth) ? <span className="break-words text-phx-sm text-slate-600">{weeklySheetAccountShortLine(account.depth)}</span> : null}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid divide-y divide-slate-100 border-t border-slate-200 md:hidden">
        {accounts.map((account) => (
          <div className="grid gap-1 px-4 py-3" key={account.customerId}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 break-words text-phx-md font-black text-slate-900" dir="auto">
                {account.name}
              </p>
              <AccountState account={account} />
            </div>
            <p className="text-phx-sm text-slate-600">{weeklySheetVisitsWord(account.visits)}</p>
            {account.depth.noDoctorsWritten ? (
              <p className="text-phx-sm font-semibold text-slate-500">{WEEKLY_SHEET_NO_DOCTORS}</p>
            ) : (
              <>
                <p className="text-phx-sm text-slate-700">
                  {WEEKLY_SHEET_FAMILIES.map((family, index) => (
                    <span key={family}>
                      {index > 0 ? " · " : ""}
                      {DOCTOR_FAMILY_LABEL[family]} <Depth account={account} family={family} />
                    </span>
                  ))}
                </p>
                {weeklySheetAccountShortLine(account.depth) ? <p className="break-words text-phx-sm text-slate-600">{weeklySheetAccountShortLine(account.depth)}</p> : null}
              </>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

const REP_GRID = "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)]";

function MobileLabel({ children }: { children: ReactNode }) {
  return <p className="text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500 md:hidden">{children}</p>;
}

/** The five cells of a rep's row — the same on a row that opens and on one with nothing to open. */
function RepCells({ position, rep, toggle }: { position: WeeklySheetPosition; rep: WeeklySheetRep; toggle: ReactNode }) {
  const verdicts = weeklySheetRepVerdicts(rep, position);
  const waiting = weeklySheetWaitingLine(rep.waiting);
  return (
    <>
      <div className="min-w-0">
        <p className={`break-words text-phx-md font-black ${rep.vacant ? "text-slate-500" : "text-slate-900"}`}>{rep.person}</p>
        <p className="break-words text-phx-sm text-slate-500">{weeklySheetRepDaysLine(rep)}</p>
        {!rep.vacant && verdicts.pm === "No working day" ? <p className="text-phx-sm font-semibold text-slate-500">No working day this week, so nothing is graded</p> : null}
      </div>
      <div className="min-w-0">
        <MobileLabel>PM</MobileLabel>
        <Figure position={position} target={rep.pmTarget} vacant={rep.vacant} value={rep.pm} />
      </div>
      <div className="min-w-0">
        <MobileLabel>AM</MobileLabel>
        <Figure position={position} target={rep.amTarget} vacant={rep.vacant} value={rep.am} />
      </div>
      <div className="min-w-0">
        <MobileLabel>Pharmacies</MobileLabel>
        <p className="text-phx-md font-black tabular-nums text-slate-900">{rep.pharmacies}</p>
        {waiting ? <p className="text-phx-xs font-semibold text-amber-700">{waiting}</p> : null}
      </div>
      <div className="min-w-0">
        <MobileLabel>Accounts with 3 of each</MobileLabel>
        <p className="text-phx-md font-black tabular-nums text-slate-900">
          {rep.accountsMet} of {rep.accounts.length}
        </p>
        {toggle}
      </div>
    </>
  );
}

function RepBlock({ position, rep }: { position: WeeklySheetPosition; rep: WeeklySheetRep }) {
  const anchor = weeklySheetRepAnchor(rep);
  if (rep.accounts.length === 0) {
    return (
      <div className={`grid scroll-mt-4 gap-2 border-b border-slate-100 px-4 py-3 last:border-b-0 md:items-start md:gap-3 ${REP_GRID} ${rep.vacant ? "bg-slate-50" : ""}`} id={anchor}>
        <RepCells position={position} rep={rep} toggle={<p className="text-phx-xs font-semibold text-slate-500">No AM account this week</p>} />
      </div>
    );
  }
  return (
    <details className="group scroll-mt-4 border-b border-slate-100 last:border-b-0" id={anchor}>
      <summary className={`grid cursor-pointer list-none gap-2 px-4 py-3 hover:bg-slate-50 md:items-start md:gap-3 ${REP_GRID}`}>
        <RepCells
          position={position}
          rep={rep}
          toggle={
            <>
              <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-orange-700 group-open:hidden">Show {weeklySheetAccountsWord(rep.accounts.length)}</p>
              <p className="hidden text-phx-xs font-black uppercase tracking-[0.1em] text-orange-700 group-open:block">Hide accounts</p>
            </>
          }
        />
      </summary>
      <Accounts rep={rep} />
    </details>
  );
}

export function WeeklySheetView({ sheet, show = "all" }: { sheet: WeeklySheet; show?: WeeklySheetShow }) {
  const position = weeklySheetPosition(sheet);
  const districts = filterWeeklySheetDistricts(sheet, show);
  // A heading's caption and figures are the whole district's, whatever the filter lists under it.
  const wholeDistrict = new Map(sheet.districts.map((district) => [weeklySheetDistrictKey(district), district]));
  return (
    <div className="grid gap-4">
      <WeeklySheetToolbar sheet={sheet} show={show} />
      {sheet.targetsUncertain ? (
        <p className="border border-amber-300 bg-amber-50 px-4 py-2 text-phx-sm font-semibold text-amber-900">
          The holiday calendar or approved leave could not be read just now, so a target may be one day too high.
        </p>
      ) : null}
      {sheet.districts.length === 0 ? (
        <p className="border border-slate-200 bg-white p-4 text-phx-md text-slate-600">{weeklySheetShowEmptyLine("all", position)}</p>
      ) : (
        <>
          <WeeklySheetTiles sheet={sheet} />
          <WeeklySheetStandPanel sheet={sheet} />
          <WeeklySheetAttentionPanel sheet={sheet} show={show} />
          <WeeklySheetAccountsPanel sheet={sheet} />
          {districts.length === 0 ? <p className="border border-slate-200 bg-white p-4 text-phx-md text-slate-600">{weeklySheetShowEmptyLine(show, position)}</p> : null}
        </>
      )}
      {districts.map((district) => {
        const whole = wholeDistrict.get(weeklySheetDistrictKey(district)) ?? district;
        const totals = weeklySheetTotals(whole.reps, position);
        return (
          <div className="border border-slate-200" key={weeklySheetDistrictKey(district)}>
            <KpiSection
              description={`${regionGroupCaption(whole.reps.length, whole.vacantSeats)} · ${weeklySheetDistrictLine(totals, position)}`}
              title={regionManagerTitle(district.regionName, district.managerName)}
            >
              <div className={`hidden gap-3 border-b border-slate-200 bg-slate-50 px-4 py-2 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-500 md:grid ${REP_GRID}`}>
                <span>Rep</span>
                <span>PM</span>
                <span>AM</span>
                <span>Pharmacies</span>
                <span>Accounts with 3 of each</span>
              </div>
              {district.reps.map((rep) => (
                <RepBlock key={rep.seatId} position={position} rep={rep} />
              ))}
            </KpiSection>
          </div>
        );
      })}
    </div>
  );
}
