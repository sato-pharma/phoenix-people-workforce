// The Reps Plans drill-down, shared by both shells.
//
// ONE BODY, TWO DOORS. /admin/reps-plans/[rep] and /employee-portals/reps-plans/[rep] render this;
// each page contributes only its own access gate and its own chrome. Extracted 2026-09-03 when the
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
import { loadCallRateReport, loadJobTitlesByHrId, loadRepNamesByHrId } from "@/lib/crm/call-rate-service";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import { loadCrmMappingCoverage, loadRepVisits } from "@/lib/crm/rep-visits-data";
import { buildRepsPlansBoard, repsPlansRange, resolveRepsPlansMonth } from "@/lib/crm/reps-plans";

export type RepVisitsPageQuery = {
  line?: string;
  month?: string;
  period?: string;
  region?: string;
};

export async function RepVisitsPageBody({
  access,
  basePath,
  query,
  repParam,
}: {
  access: AccessContext;
  /** "/admin/reps-plans" or "/employee-portals/reps-plans" — the board this drill-down belongs to. */
  basePath: string;
  query: RepVisitsPageQuery | undefined;
  /** The url-encoded rep key from the route segment. */
  repParam: string;
}) {
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(query?.month, today);
  // The SAME window the board was read on. A rep opened from a one-week board must be scored over
  // that week here too, or the drill-down contradicts the row that was clicked.
  const range = repsPlansRange(month, today, query?.period);
  // The board's own key — "crm:2103" — url-encoded into the path. Deliberately the SAME identity the
  // board uses rather than a second scheme keyed on hr id: one person occupying two keys is exactly
  // how a rep silently becomes two rows, and this page has to land on the row that was clicked.
  const repKey = decodeURIComponent(repParam);
  // Preserves the filters the reader came in with, so Back returns to the board they were reading.
  const backQuery = new URLSearchParams({ month });
  if (range.periodKey !== "month") backQuery.set("period", range.periodKey);
  if (query?.line) backQuery.set("line", query.line);
  if (query?.region) backQuery.set("region", query.region);
  const backHref = `${basePath}?${backQuery.toString()}`;

  // The board is rebuilt here rather than passed through, so the header cannot drift from the row
  // that was clicked: same report, same organogram, same scope, same shaping — the identical
  // RepsPlansRepRow.
  let board: Awaited<ReturnType<typeof buildRepsPlansBoard>> | null = null;
  let loadError: string | null = null;
  try {
    const [report, repNameByHrId, jobTitleByHrId, tree, scope] = await Promise.all([
      loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
      loadRepNamesByHrId().catch(() => undefined),
      loadJobTitlesByHrId().catch(() => undefined),
      loadOrgPlacementTree().catch(() => null),
      // NO .catch(). The three above degrade to a poorer page; this one degrades to a WIDER one, and
      // a scope that throws must take the page down rather than quietly become company-wide. Every
      // rep this viewer may not see is absent from `board.reps`, so the lookup below finds no row
      // and lands on the notice — which is the whole URL defence.
      getDoctorCoverageScope(access),
    ]);
    board = buildRepsPlansBoard(report, {
      isCurrentMonth: range.isCurrentMonth,
      jobTitleByHrId,
      month,
      range,
      repNameByHrId,
      scope,
      tree,
    });
  } catch (error) {
    loadError = error instanceof Error ? error.message : "CRM visit data is unavailable.";
  }

  if (!board) {
    return (
      <div className="border border-rose-200 bg-rose-50 px-5 py-4">
        <p className="text-sm font-bold text-rose-800">These visits could not load.</p>
        <p className="mt-1 text-xs text-rose-700">{loadError}</p>
      </div>
    );
  }

  const row = board.reps.find((candidate) => candidate.repKey === repKey) ?? null;
  if (!row) {
    // Not a crash, and deliberately the SAME answer for two different causes: a rep who recorded
    // nothing in the month asked for, and a rep this viewer has no reach over. Naming which one it
    // is would turn the page into an oracle for whether a given key belongs to somebody else's team.
    return (
      <div className="space-y-4">
        <Link className="text-xs font-bold text-orange-600 hover:underline" href={backHref}>
          ← Back to Reps Plans
        </Link>
        <div className="border border-amber-200 bg-amber-50 px-5 py-4">
          <p className="text-sm font-bold text-amber-900">
            Nobody by that key recorded field work in{" "}
            {board.isWholeMonth ? board.monthLabel : `${board.monthLabel} · ${board.periodLabel}`}.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            Widen the period or pick a different month on the board — one week can be genuinely empty for a rep who was
            on leave, and a rep who joined or left mid-year is absent from the months either side of his own.
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
      // The directory names the double-visit partner, for the same reason it names the rep: the
      // CRM's `double_name` is a login handle.
      partnerNameByHrId: await loadRepNamesByHrId().catch(() => undefined),
    }),
    loadCrmMappingCoverage(),
  ]);

  const territory = row.territories.map((cell) => `${cell.lineName} · ${cell.regionName}`).join("  |  ");
  const roleLabel = row.seatTierLabel ?? row.jobTitle ?? "Not in organogram";
  // The window these rows and the two rates above them were BOTH measured over. Naming the month
  // alone while a week is in view is what made the rate look wrong in the first place.
  const windowLabel = board.isWholeMonth ? board.monthLabel : `${board.monthLabel} · ${board.periodLabel}`;

  return (
    <div className="space-y-5">
      <Link className="text-xs font-bold text-orange-600 hover:underline" href={backHref}>
        ← Back to Reps Plans
      </Link>

      {/* The person, resolved through the organogram — the same seat, tier, line and region the board
          shows, because it is the same row object. The HR id is printed because it is the join that
          makes all of this one system rather than two. */}
      <div className="border border-slate-200 bg-white px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-black text-slate-900">{row.repName}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-500">
              <span className="border border-slate-300 bg-slate-50 px-2 py-0.5 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-600">
                {roleLabel}
              </span>
              {territory ? <span>{territory}</span> : null}
              {row.agentHrId ? <span className="text-slate-400">HR {row.agentHrId.toUpperCase()}</span> : null}
            </p>
          </div>
          {/* The board's own two rates, repeated here so the reader can see at a glance that the rows
              below are what produced them. A manager's percentages stay blank, exactly as on the
              board — the 2 AM / 10 PM target is a medical rep's. */}
          <div className="flex gap-5">
            <div className="text-right">
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
                {row.scored ? `AM of ${row.am.target}` : "AM rate"}
              </p>
              <p className="text-lg font-black text-slate-900">{row.am.verifiedRate?.toFixed(1) ?? "—"}</p>
            </div>
            <div className="text-right">
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
                {row.scored ? `PM of ${row.pm.target}` : "PM rate"}
              </p>
              <p className="text-lg font-black text-slate-900">{row.pm.verifiedRate?.toFixed(1) ?? "—"}</p>
            </div>
            <div className="text-right">
              <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Working days</p>
              <p className="text-lg font-black text-slate-900">{row.workingDays}</p>
            </div>
          </div>
        </div>
        <p className="mt-3 text-phx-xs text-slate-400">
          {windowLabel} · {row.workingDays} working {row.workingDays === 1 ? "day" : "days"} · every call below is
          classified by the same rule the rate uses, so these rows and that rate are the same number seen twice.
        </p>
      </div>

      <RepVisitsDetail
        mappedRegions={mapping.mappedRegions}
        monthLabel={windowLabel}
        rows={visits.rows}
        summary={visits.summary}
      />
    </div>
  );
}
