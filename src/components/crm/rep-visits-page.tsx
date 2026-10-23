// One rep's visits behind his KPIs Call Rate row, shared by both shells.
//
// ONE BODY, TWO DOORS. /admin/kpis/call-rate/[rep] and /employee-portals/kpis/call-rate/[rep] render
// this — the Reps Plans module's rep page, which moved under Reps List when the owner merged the two
// modules on 2026-09-21 and under KPIs the same day, when he took the call rate off Reps List because
// KPIs already carries it and chose "Open it from KPIs" for this page. Every older address
// (/reps-plans/[rep], /reps-list/call-rate/[rep]) forwards here. Each page contributes only its own
// access gate and its own chrome. Extracted 2026-09-03 when the
// portal twin landed, rather than copied: this file rebuilds the board to find the clicked row, so a
// copy that drifted would be a copy whose SCOPE drifted — and a drill-down quietly wider than the
// board that links to it is exactly the fault a guessed URL is aimed at.
//
// The owner's instruction behind the page, 2026-08-28: "now do the drill down to the visits. I don't
// want visits to be a raw text. I want everything to be connected to the organogram and the bricks
// and the areas and the regions of the users." So the header resolves the PERSON through
// au_v_org_tree — his seat, his tier, his line and region — exactly as the board does, and every row
// below resolves the visit through a real record rather than printing what the CRM happened to type.
// What cannot be resolved is SAID so, with the number of rows affected and the one screen that fixes
// it; it is never blanked and never guessed.
import Link from "next/link";

import { RepVisitsDetail } from "@/components/crm/rep-visits-detail";
import type { AccessContext } from "@/lib/auth/permissions";
import { loadCallRateHolidays } from "@/lib/crm/call-rate-holidays";
import { loadCallRateReport, loadJobTitlesByHrId, loadRepNamesByHrId } from "@/lib/crm/call-rate-service";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { phoenixDetailViewer } from "@/lib/crm/phoenix-visit-detail";
import { resolveRepKeyAgents } from "@/lib/crm/kpi-board-agents";
import { KPIS_CALL_RATE_TAB, PORTAL_CALL_RATE_PATH, PORTAL_KPIS_PATH } from "@/lib/crm/kpis-call-rate-route";
import { buildKpisQuery, parseKpiFilters } from "@/lib/crm/kpis-filters";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import { loadCrmMappingCoverage, loadRepVisits } from "@/lib/crm/rep-visits-data";
import { buildRepsPlansBoard, CALL_RATE_THROUGH_YESTERDAY, repsPlansRange, resolveRepsPlansMonth } from "@/lib/crm/reps-plans";
import { logPortalFailure } from "@/lib/observability/portal-logging";

/**
 * The KPIs board's own query, carried through unchanged — month, window and every advanced filter —
 * so Back lands on exactly the board the row was clicked on. Left open for the same reason the KPIs
 * page leaves it open: parseKpiFilters drops anything it does not recognise.
 */
export type RepVisitsPageQuery = Record<string, string | string[] | undefined>;

/** First value only: a repeated `?month=a&month=b` must resolve to one month, not to an array. */
function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function RepVisitsPageBody({
  access,
  basePath,
  query,
  repParam,
  surface = "admin",
}: {
  access: AccessContext;
  /** "/admin/kpis" or "/employee-portals/kpis" — the KPIs board whose Call Rate tab this page
   * belongs to. Back returns to that tab. */
  basePath: string;
  query: RepVisitsPageQuery | undefined;
  /** The url-encoded rep key from the route segment. */
  repParam: string;
  /**
   * WHICH SHELL draws the page. `admin` (the default, so the admin twin renders exactly as before)
   * owns the page's only heading, so the rep's name is its `<h1>`. `portal` sits under
   * EmployeePortalPageShell, which has already drawn the `<h1>` — so the name steps down to an `<h2>`,
   * the stats sit on a grid a phone can read, a load failure is logged and explained in words, and
   * the admin-only "map the regions" instruction is not shown to a rep who cannot open that screen.
   */
  surface?: "admin" | "portal";
}) {
  const portal = surface === "portal";
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(one(query?.month), today);
  // The SAME window the board was read on. A rep opened from a one-week board must be scored over
  // that week here too, or the drill-down contradicts the row that was clicked — through yesterday,
  // as the tab is (ruling C1).
  const range = repsPlansRange(month, today, one(query?.period), CALL_RATE_THROUGH_YESTERDAY);
  // The call-rate board's own key — "crm:2103" — url-encoded into the path, or "hr:<id>" for a rep
  // with no CRM account (kpiCallRateRepKey). Deliberately the SAME identity the board keys its rows
  // by: one person occupying two schemes is exactly how a rep silently becomes two rows, and this
  // page has to land on the row that was clicked.
  let repKey = repParam;
  try {
    repKey = decodeURIComponent(repParam);
  } catch {
    // A malformed escape names nobody; the lookup below answers so.
  }
  // Built by the KPIs board's ONE query builder from the filters the reader came in with, so Back
  // returns to the board they were reading — same month, window and filters, on the Call Rate tab.
  // In the portal the call rate is a page of its own (owner, 2026-10-14), so Back returns to it rather
  // than to a `?tab=` the KPIs page would only redirect from; the admin shell still reads the tab.
  const portalCallRate = basePath === PORTAL_KPIS_PATH;
  const backHref = `${portalCallRate ? PORTAL_CALL_RATE_PATH : basePath}?${buildKpisQuery({
    month,
    period: range.periodKey,
    tab: portalCallRate ? "summary" : KPIS_CALL_RATE_TAB,
    filters: parseKpiFilters(query ?? {}),
  })}`;

  // The board is rebuilt here rather than passed through, so the header cannot drift from the row
  // that was clicked: same report, same organogram, same scope, same shaping — the identical
  // RepsPlansRepRow.
  //
  // THE HOLIDAYS ARE READ ONCE, and the same set goes to the rate and to the visit list, so a call on
  // a public holiday is left out of the rate AND marked "not scored" in the list — never one without
  // the other.
  // Only the clicked rep's accounts are read (crm/kpi-board-agents.ts, resolveRepKeyAgents): the page
  // draws his row alone, and it used to read the whole field force's window to find it.
  const [holidays, agents] = await Promise.all([
    loadCallRateHolidays(range.dateFrom, range.dateTo),
    resolveRepKeyAgents(repKey, { from: range.dateFrom, to: range.dateTo }).catch(() => null),
  ]);
  let board: Awaited<ReturnType<typeof buildRepsPlansBoard>> | null = null;
  let partnerNameByHrId: Awaited<ReturnType<typeof loadRepNamesByHrId>> | undefined;
  let holidaysComplete = holidays.complete;
  let loadError: string | null = null;
  try {
    const [report, repNameByHrId, jobTitleByHrId, tree, scope] = await Promise.all([
      // A display page: when the rep's own accounts could not be resolved and the whole company is
      // read, that window may be the same minute-old copy the KPIs board reads (crm/reads.ts).
      loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo, holidays, reuseRecentWindow: true, ...(agents ? { agents } : {}) }),
      loadRepNamesByHrId().catch(() => undefined),
      loadJobTitlesByHrId().catch(() => undefined),
      loadOrgPlacementTree().catch(() => null),
      // NO .catch(). The three above degrade to a poorer page; this one degrades to a WIDER one, and
      // a scope that throws must take the page down rather than quietly become company-wide. Every
      // rep this viewer may not see is absent from `board.reps`, so the lookup below finds no row
      // and lands on the notice — which is the whole URL defence.
      getDoctorCoverageScope(access),
    ]);
    holidaysComplete = report.holidaysComplete;
    partnerNameByHrId = repNameByHrId;
    board = buildRepsPlansBoard(report, {
      isCurrentMonth: range.isCurrentMonth,
      jobTitleByHrId,
      month,
      range,
      // Resolved by the board over the viewer's SCOPED rows: a `crm:` key must be one of them, and an
      // `hr:` key opens that person's busiest account among them. A key outside the reach resolves
      // to nothing.
      repKey,
      repNameByHrId,
      scope,
      tree,
    });
  } catch (error) {
    // The portal logs the failure and says what happened in words — `error.message` on this path is a
    // Supabase or PostgREST sentence, never something to print to a medical rep. The admin twin keeps
    // the raw text for the people who fix it.
    if (portal) logPortalFailure({ hrId: access.hrId, module: "kpis", role: access.role, route: basePath }, error);
    loadError = portal
      ? "The CRM visit data is unavailable right now. This is a loading problem, not a month with no visits — try again in a minute."
      : error instanceof Error
        ? error.message
        : "CRM visit data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">These visits could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  const row = board.appliedRepKey
    ? (board.reps.find((candidate) => candidate.repKey === board.appliedRepKey) ?? null)
    : null;
  if (!row) {
    // Not a crash, and deliberately the SAME answer for two different causes: a rep who recorded
    // nothing in the month asked for, and a rep this viewer has no reach over. Naming which one it
    // is would turn the page into an oracle for whether a given key belongs to somebody else's team.
    return (
      <div className="space-y-4">
        <Link className="text-xs font-bold text-orange-600 hover:underline" href={backHref}>
          ← Back to Call Rate
        </Link>
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-bold text-amber-900">
            Nobody by that key recorded field work in{" "}
            {board.isWholeMonth ? board.monthLabel : `${board.monthLabel} · ${board.periodLabel}`}.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Widen the period or pick a different month on the board — one week can be genuinely empty for a rep who was
            on leave, and a rep who joined or left mid-year is absent from the months either side of their own.
          </p>
        </div>
      </div>
    );
  }

  const [visits, mapping] = await Promise.all([
    loadRepVisits({
      agentCrmId: row.agentCrmId,
      agentHrId: row.agentHrId,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      holidays: holidays.dates,
      // The directory names the double-visit partner, for the same reason it names the rep: the
      // CRM's `double_name` is a login handle.
      // The copy read above, not a second read awaited before the visit list may start.
      partnerNameByHrId,
      // WHO IS READING. The Phoenix field set is on this page because the owner asked for it
      // (2026-10-07, "everything, GPS and evidence included"), and WHICH half each reader sees is his
      // own 2026-10-02 ruling: the Super Admin and the SFE Manager read the measurement behind a
      // reading, every other admin seat reads the distance alone, and a reader looking at a row whose
      // rep is himself reads neither.
      viewer: phoenixDetailViewer(access.role, access.hrId),
    }),
    loadCrmMappingCoverage(),
  ]);

  const territory = row.territories.map((cell) => `${cell.lineName} · ${cell.regionName}`).join("  |  ");
  // The portal prints each territory as its own wrapping item rather than joining them with a pipe:
  // " · " already separates a line from its region inside one territory.
  const territoryCells = row.territories.map((cell) => `${cell.lineName} · ${cell.regionName}`);
  const roleLabel = row.seatTierLabel ?? row.jobTitle ?? "Not in organogram";
  // The window these rows and the two rates above them were BOTH measured over. Naming the month
  // alone while a week is in view is what made the rate look wrong in the first place.
  const windowLabel = board.isWholeMonth ? board.monthLabel : `${board.monthLabel} · ${board.periodLabel}`;

  return (
    <div className="space-y-5">
      <Link className="text-xs font-bold text-orange-600 hover:underline" href={backHref}>
        ← Back to Call Rate
      </Link>

      {/* The person, resolved through the organogram — the same seat, tier, line and region the board
          shows, because it is the same row object. Named, never coded: the HR id that joins it all is
          not printed (the owner's standing rule — names, never codes, on screen). */}
      <div className="border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className={portal ? "min-w-0" : undefined}>
            {/* The portal shell has already drawn the page's <h1> ("KPIs"), so there the name is the
                section heading under it, never a second <h1>. */}
            {portal ? (
              <h2 className="break-words text-xl font-black text-slate-900">{row.repName}</h2>
            ) : (
              <h1 className="text-xl font-black text-slate-900">{row.repName}</h1>
            )}
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
              <span className="border border-slate-300 bg-slate-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600">
                {roleLabel}
              </span>
              {portal
                ? territoryCells.map((cell, index) => (
                    <span className="break-words" key={`${cell}-${index}`}>
                      {cell}
                    </span>
                  ))
                : territory
                  ? <span>{territory}</span>
                  : null}
              {/* Ruling A1 (owner, 2026-09-21): the same marker as the board, because the rates
                  beside it read "—" for the same reason. */}
              {row.noGpsFeed ? (
                <span className="border border-amber-300 bg-amber-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-amber-700">
                  No GPS feed
                </span>
              ) : null}
            </p>
          </div>
          {/* The board's own two rates, repeated here so the reader can see at a glance that the rows
              below are what produced them. A manager's percentages stay blank, exactly as on the
              board — the 2 AM / 10 PM target is a medical rep's. */}
          {/* In the portal the four figures sit on a GRID — two by two on a phone, four across from `sm`,
              left-aligned where they stack — instead of a right-aligned flex-wrap that broke raggedly
              at 360–430px. AM, PM and Pharmacy stay three separate figures, AM first. */}
          <div className={portal ? "grid w-full grid-cols-2 gap-x-5 gap-y-3 sm:w-auto sm:grid-cols-4" : "flex flex-wrap gap-5"}>
            <div className={portal ? "min-w-0 sm:text-right" : "text-right"}>
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
                {row.scored ? `AM of ${row.am.target}` : "AM rate"}
              </p>
              <p className="text-lg font-black text-slate-900">{row.am.verifiedRate?.toFixed(2) ?? "—"}</p>
            </div>
            <div className={portal ? "min-w-0 sm:text-right" : "text-right"}>
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
                {row.scored ? `PM of ${row.pm.target}` : "PM rate"}
              </p>
              <p className="text-lg font-black text-slate-900">{row.pm.verifiedRate?.toFixed(2) ?? "—"}</p>
            </div>
            {/* Pharmacies are separate from AM/PM (owner, 2026-09-05) and have no target set yet —
                see PHARMACY_CALL_RATE_TARGET — so this tile shows the raw rate with no "of N". Zero
                is a normal reading, not a gap: never badge it the way a zero AM/PM would be. */}
            <div className={portal ? "min-w-0 sm:text-right" : "text-right"}>
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Pharmacy rate</p>
              <p className="text-lg font-black text-slate-900">{row.pharmacy.verifiedRate?.toFixed(2) ?? "—"}</p>
            </div>
            <div className={portal ? "min-w-0 sm:text-right" : "text-right"}>
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Working days</p>
              <p className="text-lg font-black text-slate-900">{row.workingDays}</p>
            </div>
          </div>
        </div>
        <p className="mt-3 text-phx-xs text-slate-400">
          {windowLabel} · {row.workingDays} working {row.workingDays === 1 ? "day" : "days"}
          {board.todayLeftOut ? " · today is not scored until it is over, so its calls are not listed yet" : ""}
          {" · "}every call below is classified by the same rule the rate uses, so these rows and that rate are the
          same number seen twice.
        </p>
        {/* THE HOLIDAY CAVEAT, in the KPIs board's own words. A holiday the calendar did not return
            is still a working day in the rate above and an unmarked day in the list below. */}
        {holidaysComplete ? null : (
          <p className="mt-2 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-xs font-semibold text-slate-700">
            The national holiday calendar could not be read for this period. Any public holiday it did not return is
            still counted as a working day, so the rates above may be lower than the real figure.
          </p>
        )}
        {row.noGpsFeed ? (
          <p className="mt-2 border-l-[3px] border-l-amber-500 bg-amber-50 px-3 py-2 text-xs font-semibold text-slate-700">
            No GPS check-in reached the CRM from this account in {windowLabel}, so none of the visits below could be
            proved. They are real reported calls; the proved rate is left blank rather than read as zero, and this rep
            is left out of the team figures on the board.
          </p>
        ) : null}
      </div>

      <RepVisitsDetail
        mappedRegions={mapping.mappedRegions}
        monthLabel={windowLabel}
        rows={visits.rows}
        summary={visits.summary}
        surface={surface}
      />
    </div>
  );
}
