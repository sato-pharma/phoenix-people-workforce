/**
 * Reps List — the Call Rate tab, assembled once for both shells.
 *
 * This is the retired Reps Plans module (owner, 2026-09-21: "merge the 2 modules into 1 module WHICH
 * REPS LIST"). The board, its rules and its shaping are unchanged — src/lib/crm/call-rate.ts (pure)
 * and src/lib/crm/reps-plans.ts — and this file is only the fetch the two Reps Plans pages each
 * carried, moved here so the admin and portal Reps List pages cannot drift on it.
 *
 * ## What degrades, and what must not
 *
 * The directory reads and the organogram degrade to a poorer board and are caught one by one: names
 * fall back to the CRM handle, and without the organogram the line and region pickers hide rather
 * than offer empty lists. The visits are load-bearing, so their failure throws — a zero on this board
 * would read as "every rep did nothing".
 *
 * THE SCOPE IS NOT CAUGHT. It degrades to a WIDER board, and a scope that failed must take the tab
 * down rather than quietly show a district manager every rep in the company. It is the resolver the
 * KPIs board asks (`getDoctorCoverageScope`), so a manager's reach is the same on both screens.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { loadCallRateReport, loadJobTitlesByHrId, loadRepNamesByHrId } from "@/lib/crm/call-rate-service";
import { coverageRepKey, type CoverageFilterSelection } from "@/lib/crm/coverage-filters";
import { cairoTodayIso } from "@/lib/crm/dates";
import { getDoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { loadOrgPlacementTree } from "@/lib/crm/org-placement-data";
import {
  buildRepsPlansBoard,
  repsPlansRange,
  repsPlansWeeks,
  resolveRepsPlansMonth,
  type RepsPlansBoard,
} from "@/lib/crm/reps-plans";

export type RepsListCallRateParams = {
  line?: string;
  month?: string;
  /** `month` (default), `w1`…`w5`, or an explicit `YYYY-MM-DD..YYYY-MM-DD`. */
  period?: string;
  region?: string;
  /** The board's own key (`crm:…`), or a Reps List `hr:…` key carried across the tab strip. */
  rep?: string;
};

export type RepsListCallRate = {
  board: RepsPlansBoard;
  /**
   * The same filters in the form the Reps List tab strip carries, so a manager who reads one rep's
   * call rate and presses Contact list lands on that rep's list, not back on the picker. The rep goes
   * out as his Reps List key — the hr id — because the call-rate board keys a rep by CRM account.
   */
  selection: CoverageFilterSelection;
};

export async function getRepsListCallRate({
  access,
  params,
}: {
  access: AccessContext;
  params: RepsListCallRateParams | undefined;
}): Promise<RepsListCallRate> {
  const today = cairoTodayIso();
  const month = resolveRepsPlansMonth(params?.month, today);
  // The window bounds the FETCH as well as the caption, so a week's rate is a week's calls over a
  // week's working days (owner, 2026-08-28: "if this is the plan of the first week, calculate the
  // call rate on the first week only, not all the month").
  const range = repsPlansRange(month, today, params?.period);
  const weekOptions = repsPlansWeeks(month, today);

  const scope = await getDoctorCoverageScope(access);
  const [report, repNameByHrId, jobTitleByHrId, tree] = await Promise.all([
    loadCallRateReport({ dateFrom: range.dateFrom, dateTo: range.dateTo }),
    loadRepNamesByHrId().catch(() => undefined),
    loadJobTitlesByHrId().catch(() => undefined),
    // au_v_org_tree, every tier. NOT a rep-only view: reading one is what once rendered 22 seated
    // District Managers, NSMs and an RSM as holding no seat at all.
    loadOrgPlacementTree().catch(() => null),
  ]);

  const board = buildRepsPlansBoard(report, {
    geography: { line: params?.line ?? null, region: params?.region ?? null },
    isCurrentMonth: range.isCurrentMonth,
    jobTitleByHrId,
    month,
    range,
    repKey: params?.rep ?? null,
    repNameByHrId,
    scope,
    tree,
    weekOptions,
  });

  const appliedRow = board.appliedRepKey ? board.reps.find((row) => row.repKey === board.appliedRepKey) : undefined;
  return {
    board,
    selection: {
      line: board.appliedLine ?? undefined,
      region: board.appliedRegion ?? undefined,
      rep: appliedRow?.agentHrId ? coverageRepKey(appliedRow.agentHrId) : undefined,
    },
  };
}
