// ─────────────────────────────────────────────────────────────────────────────
// Plan versus actual — the IO half.
//
// Reads ONE rep's visits across ONE plan's own window and hands them to the pure
// builder in plan-actuals.ts, which holds every rule about what the marks mean.
//
// NARROWED BY `agent_crm_id`, NOT BY HR ID, and that is not interchangeable. The
// plan mirror leaves `agent_hr_id` null on a large and varying share of rows —
// 791 of 18,645 August 2026 rows, but 5,795 of 20,778 May rows — so the plan side
// of this comparison is keyed by crm id, and the visits side has to be keyed the
// same way or the join has two identities. reps-list-activity-data.ts made the
// same call for the same reason; this is that pattern over a week rather than a
// month.
//
// THE WINDOW IS THE PLAN'S OWN, not the week's. A plan whose days run Sat–Wed is
// read Sat–Wed, so a doctor visited on the Thursday after it cannot be credited
// to it. `moved` means "on another day OF THIS PLAN", and widening the read would
// quietly widen that word.
// ─────────────────────────────────────────────────────────────────────────────

import { buildPlanActuals, type PlanActuals } from "@/lib/crm/plan-actuals";
import { getEffectiveExcludedAgentCrmIds, queryVisits } from "@/lib/crm/reads";
import { CAMPAIGN_TYPE } from "@/lib/crm/visit-types";

/** The three columns the comparison needs, and nothing else. */
const VISIT_COLUMNS = "agent_crm_id, contact_crm_id, visit_date, visit_type";

type ActualVisitRow = {
  agent_crm_id: number | null;
  contact_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
};

/**
 * What one rep actually did across one plan's window.
 *
 * `null` means the comparison CANNOT be made, and every caller must render that as no marks at all
 * rather than as a week of misses. There are two ways to get it, and both are the same mistake if
 * they are allowed to look like evidence:
 *
 * 1. **A departed agent.** Every CRM visit read excludes one by standing rule, unconditionally. The
 *    plan side does not. Reading on would compare a full plan against zero visits and mark every
 *    doctor "not seen" — the most damaging possible wrong answer, and one that looks entirely
 *    plausible on screen.
 * 2. **A failed read.** A visits mirror that was briefly unreachable must not be able to accuse a
 *    rep of a week he may well have worked.
 *
 * The two rules that decide WHICH visits count live in plan-actuals.ts, not here. Campaign rows are
 * fetched deliberately — they name no doctor and can never match a planned call, but a rep whose day
 * was all campaign work must not read as an idle one, so the day summary counts them separately.
 */
export async function loadPlanActuals(input: {
  agentCrmId: number;
  /** ISO, inclusive — the plan's own first and last planned day. */
  dateFrom: string;
  dateTo: string;
  /** Cairo today, ISO. Passed in so the verdicts are testable and no `Date` is built downstream. */
  today: string;
}): Promise<PlanActuals | null> {
  try {
    const excludedAgentCrmIds = await getEffectiveExcludedAgentCrmIds();
    if (excludedAgentCrmIds.includes(input.agentCrmId)) return null;

    const rows = await queryVisits<ActualVisitRow>({
      agentCrmIds: [input.agentCrmId],
      // A doctor double-visited is one stop, not two. Without this a shared call would count twice
      // in the day summary while satisfying exactly one plan row, and the two would disagree.
      collapseDoubleVisits: true,
      columns: VISIT_COLUMNS,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      visitTypes: [0, CAMPAIGN_TYPE],
    });

    return buildPlanActuals(
      rows.map((row) => ({
        campaign: row.visit_type === CAMPAIGN_TYPE,
        contactCrmId: row.contact_crm_id,
        dateIso: row.visit_date ? String(row.visit_date).slice(0, 10) : null,
      })),
      input.today,
    );
  } catch {
    return null;
  }
}
