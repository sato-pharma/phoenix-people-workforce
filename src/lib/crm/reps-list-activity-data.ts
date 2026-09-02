// ─────────────────────────────────────────────────────────────────────────────
// Reps List activity — the IO half.
//
// Reads ONE rep's plan and visits for one month and hands them to the pure
// builder in rep-doctor-lists.ts. The shaping is not re-implemented here: the
// statuses this board prints are accusations about named people, and there must
// be exactly one place in Phoenix that decides what "behind plan" means.
//
// WHY NOT JUST CALL `getRepDoctorLists`. That door reads the plan mirror and the
// visits mirror COMPANY-WIDE — about 9,000 plan rows and 17,600 visit rows for a
// single month — and then filters to one rep in memory. Correct, and far too much
// work for a page that re-runs on every cascade change. So the two halves are
// narrowed in the QUERY and the identical pure function is called on the result.
// This is that same pattern with an agent filter rather than a month loop —
// rep-doctor-lists-trend.ts used to hold the month-loop version and was deleted
// on 2026-09-02 with the unreachable board that was its only consumer.
//
// BOTH HALVES ARE NARROWED BY `agent_crm_id`, AND THAT IS NOT INTERCHANGEABLE
// WITH THE HR ID. `scanPlanEntries` says why in its own doc: the plan mirror
// leaves `agent_hr_id` null on a large and varying share of rows — 791 of 18,645
// August 2026 rows, but 5,795 of 20,778 May rows (27.9%), and 26 of 98 agents in
// a four-month window carry no hr id on a single plan row. Filtering the plan by
// hr id would silently drop a quarter of a month's lists, and every doctor thus
// dropped would read as `untouched` — a fabricated accusation. `agent_crm_id` is
// null on none of them, so the visits side is narrowed the same way (the
// `agentCrmIds` filter added to reads.ts for this) and the join has one identity
// end to end.
// ─────────────────────────────────────────────────────────────────────────────

import { DEFAULT_DOCTOR_COVERAGE_NORMS } from "@/lib/crm/doctor-coverage-config";
import { getEffectiveExcludedAgentCrmIds, queryVisits } from "@/lib/crm/reads";
import {
  buildRepDoctorListsBoard,
  monthBounds,
  scanPlanEntries,
  type VisitRow,
} from "@/lib/crm/rep-doctor-lists";
import { buildRepsListActivityIndex, type RepsListActivity } from "@/lib/crm/reps-list-activity";
import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";

/** The projection `buildRepDoctorListsBoard` reads. Copied from `getRepDoctorLists` so the two
 * cannot drift — a column missing here is a field silently undefined in the shared builder. */
const VISIT_COLUMNS =
  "agent_crm_id, agent_hr_id, agent_name, contact_crm_id, crm_contact_grade, speciality, visit_date, visit_type";

/**
 * One rep's month, as `contactCrmId -> activity`.
 *
 * `null` means the activity could not be established at all, which the board must render as an
 * ABSENT column rather than as an empty one. The two cases are not the same statement: an empty
 * index says "nothing happened to any of these doctors", and on a list of 84 names that is an
 * accusation. See `activityForContact`.
 */
export async function loadRepsListActivity(input: {
  agentCrmId: number;
  month: string;
  /** Injectable for tests only — the to-date basis is the one part of this that moves with the
   * wall clock. Production never passes it; the builder defaults it to today (Cairo). */
  asOf?: string;
}): Promise<Map<number, RepsListActivity> | null> {
  const { from, to } = monthBounds(input.month);

  // A departed agent is invisible to every CRM read by standing rule, and the visits door enforces
  // that unconditionally. The plan side does not, so reading on would return a full plan against
  // zero visits and mark every doctor `missed` — the most damaging possible wrong answer, and one
  // that looks entirely plausible. Answer "unavailable" instead, which the board says in words.
  const excludedAgentCrmIds = await getEffectiveExcludedAgentCrmIds();
  if (excludedAgentCrmIds.includes(input.agentCrmId)) return null;

  const [planRows, visitRows] = await Promise.all([
    // The board's own plan reader, not a second hand-written select — one projection, one door.
    scanPlanEntries(from, to, { agentCrmIds: [input.agentCrmId] }),
    queryVisits<VisitRow>({
      agentCrmIds: [input.agentCrmId],
      // The rep may have double-visited a doctor, and the CRM client saves one real stop as several
      // rows. Collapsing is what makes "2 of 3" mean two stops rather than two saves.
      collapseDoubleVisits: true,
      columns: VISIT_COLUMNS,
      dateFrom: from,
      dateTo: to,
      // Campaign rows are loaded and then dropped inside the builder. They are fetched because a rep
      // whose month was all campaign work must not read as idle; they can never satisfy a planned
      // call, because a campaign row names no doctor.
      visitTypes: [0, CAMPAIGN_TYPE],
    }),
  ]);

  const board = buildRepDoctorListsBoard({
    asOf: input.asOf,
    // The builder uses this only to put a display NAME on a rep row. This board already knows whose
    // list it is showing and reads only the doctor rows, so resolving the whole employee directory
    // here would be an IO round trip spent on a field nobody reads.
    employeeNameByHrId: new Map<string, string>(),
    excludedAgentCrmIds,
    // THE SAFETY NET FOR THE JOIN. Both queries above are already narrowed to this agent; this makes
    // the builder drop anything that is somehow not his, so a widened query later cannot silently
    // start attributing another rep's visits to these contacts.
    filters: { repKey: String(input.agentCrmId) },
    month: input.month,
    // Grade norms feed `gradeNormCalls` and `planBelowGradeNorm` ONLY — never `frequencyStatus`,
    // which is the sole field this board reads (`frequencyStatusOf` takes actual, plannedCalls and
    // plannedToDate and nothing else). So the compile-time defaults are not a degraded read here;
    // loading the admin-editable table would buy a field that is thrown away.
    norms: DEFAULT_DOCTOR_COVERAGE_NORMS,
    planRows,
    visitRows,
  });

  return buildRepsListActivityIndex(board.doctors);
}
