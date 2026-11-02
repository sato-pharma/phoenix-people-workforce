/**
 * Which reps' rows the KPIs board reads, when its scope is a handful of people.
 *
 * 🔴 WHY THIS EXISTS (2026-10-01, "speed up the slowest portal page"). The board read the WHOLE
 * company's month — every visit, check-in and plan entry — and then kept the rows of the reps its
 * viewer may see. A medical rep's landing page asks it for his own KPI tile, so that was the company
 * read for one row: measured on production with the code of that day, 2.7 s of a 30 September
 * landing, the two company-wide loaders alone 1.0 s and 1.4 s, against 105 ms on the 1st. The
 * landing page is the rep's home, so he paid it on almost every return to it, more every day.
 *
 * WHY THESE ROWS ARE THE SAME ROWS. The board groups a rep by his CRM id (by hr id only when he has
 * none), and decides he is in scope from the hr id found on his OWN rows — the call rate's first
 * non-blank one, else the doctor lists' first (`joinKpiRows`). So a CRM id is on the board only if
 * some row of it carries an in-scope hr id, and then every row of it counts, including the vendor
 * rows whose hr id is blank. Hence two steps:
 *
 *   1. every CRM id on any VISIT or PLAN row that carries an in-scope hr id in the window, and
 *   2. every row of those CRM ids, plus the in-scope rows that carry no CRM id at all.
 *
 * A CRM id found in step 1 whose identity some OTHER person's rows decide is still read whole and
 * judged by the same code, so it lands exactly where the company-wide read put it. Plans are part of
 * step 1 for the 1st of every month: a rep with no visit yet has his hr id only on his plan rows, and
 * missing them would drop his call-rate rows from the merged row. The duplicate collapse and the
 * check-in match both key on the agent, so neither looks across reps (call-rate-service.ts).
 *
 * BOUNDED. More than KPI_NARROW_MAX_PEOPLE people, or more than KPI_NARROW_MAX_CRM_IDS ids, reads
 * company-wide as before: the ids travel in the request URL, and a list past a few hundred values
 * comes back EMPTY with no error (see PLAN_AGENT_CHUNK), which would read as a rep with no work. A
 * discovery that fails also reads company-wide — slower, never wrong.
 */

import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { queryVisits } from "@/lib/crm/reads";
import { scanPlanEntries, type PlanChunkMemo } from "@/lib/crm/rep-doctor-lists";
import { logWarning } from "@/lib/observability/log";

/** A district manager's team fits; a whole line does not, and keeps the company-wide read. */
export const KPI_NARROW_MAX_PEOPLE = 8;
/** Inside the 50-value house limit for one `in` list, with room for the hr ids beside it. */
export const KPI_NARROW_MAX_CRM_IDS = 40;

export type KpiBoardAgents = { crmIds: number[]; hrIds: string[] };

/** The distinct CRM ids the rows carry, ascending. Pure, exported for its test. */
export function crmIdsCarriedBy(rows: readonly { agent_crm_id?: number | null }[]): number[] {
  const ids = new Set<number>();
  for (const row of rows) {
    const id = row.agent_crm_id;
    if (typeof id === "number" && Number.isFinite(id)) ids.add(id);
  }
  return [...ids].sort((left, right) => left - right);
}

/** The two discovery reads, injectable so the test drives the real decision with fixture rows. */
export type KpiBoardAgentReaders = {
  visits: (filter: { agentHrIds: string[]; dateFrom: string; dateTo: string }) => Promise<readonly { agent_crm_id?: number | null }[]>;
  plans: (from: string, to: string, filter: { agentHrIds: string[] }) => Promise<readonly { agent_crm_id?: number | null }[]>;
};

const DOOR_READERS: KpiBoardAgentReaders = {
  visits: (filter) => queryVisits<{ agent_crm_id: number | null }>({ ...filter, columns: "agent_crm_id" }),
  plans: (from, to, filter) => scanPlanEntries(from, to, filter),
};

/**
 * The reps to read for this scope over `window` (the board's whole span, plans included), or null
 * to read the whole company. An `agents` scope that names nobody reads nobody, which is also what
 * the company-wide read would have shown it.
 */
export async function resolveKpiBoardAgents(
  scope: DoctorCoverageScope,
  window: { from: string; to: string },
  /** Injected only by the test — production always reads through the CRM doors. */
  readers: KpiBoardAgentReaders = DOOR_READERS,
): Promise<KpiBoardAgents | null> {
  if (scope.kind !== "agents") return null;
  const hrIds = [...new Set(scope.agentHrIds.map((id) => String(id ?? "").trim()).filter((id) => id.length > 0))];
  if (hrIds.length === 0) return { crmIds: [], hrIds: [] };
  if (hrIds.length > KPI_NARROW_MAX_PEOPLE) return null;
  try {
    const [visitRows, planRows] = await Promise.all([
      readers.visits({ agentHrIds: hrIds, dateFrom: window.from, dateTo: window.to }),
      readers.plans(window.from, window.to, { agentHrIds: hrIds }),
    ]);
    const crmIds = crmIdsCarriedBy([...visitRows, ...planRows]);
    if (crmIds.length > KPI_NARROW_MAX_CRM_IDS) return null;
    return { crmIds, hrIds };
  } catch (error) {
    logWarning("KPIs board could not narrow its reads; reading company-wide", {
      labels: { event: "kpi_board_narrowing_failed" },
      error,
    });
    return null;
  }
}

/**
 * The discovery ONE board asks: the same window answers once, and its plan read lands in the board's own
 * memo, so the doctor lists and the Phoenix half need not read those rows again (2 Nov 2026, "fix the
 * portal home slow opens"). The board's scope is fixed, so the window is the whole key.
 */
export function kpiBoardDiscovery(planChunks: PlanChunkMemo) {
  const readers: KpiBoardAgentReaders = {
    ...DOOR_READERS,
    plans: (from, to, filter) => scanPlanEntries(from, to, { ...filter, memo: planChunks }),
  };
  const held = new Map<string, Promise<KpiBoardAgents | null>>();
  return (scope: DoctorCoverageScope, window: { from: string; to: string }): Promise<KpiBoardAgents | null> => {
    const key = `${window.from}|${window.to}`;
    const known = held.get(key);
    if (known) return known;
    const read = resolveKpiBoardAgents(scope, window, readers);
    held.set(key, read);
    return read;
  };
}

/**
 * The reps to read for ONE rep's call-rate page (2026-10-23), by the board key it was opened with
 * (`kpiCallRateRepKey`), or null to read the whole field force as before.
 *
 * The page rebuilds the call-rate board to find the clicked row, and it read every rep's month to do
 * so — one request per day to the visits and check-ins views, each rebuilding every Phoenix entry
 * day. Only the clicked row is drawn, and a row is built from its own account's rows alone:
 *   · `crm:<id>` — the account's rows, all of which carry that CRM id. Its identity (the first
 *     non-blank hr id on them), its duplicate collapse and its check-in match never look past it.
 *   · `hr:<id>` — opens that person's busiest account among the scoped rows, so every account of his
 *     is read: the same discovery as a one-person scope above, which also finds his rows with no CRM id.
 * Anything else, or a discovery that fails, reads the whole field force: slower, never wrong.
 */
export async function resolveRepKeyAgents(
  repKey: string,
  window: { from: string; to: string },
  readers: KpiBoardAgentReaders = DOOR_READERS,
): Promise<KpiBoardAgents | null> {
  const crm = /^crm:(\d+)$/.exec(repKey.trim());
  if (crm) {
    const id = Number(crm[1]);
    return Number.isSafeInteger(id) ? { crmIds: [id], hrIds: [] } : null;
  }
  const hr = /^hr:(.+)$/.exec(repKey.trim());
  if (hr && hr[1].trim()) return resolveKpiBoardAgents({ kind: "agents", basis: "self", agentHrIds: [hr[1].trim()], label: repKey }, window, readers);
  return null;
}
