// ─────────────────────────────────────────────────────────────────────────────
// The reader half of the two KPI reports. The rules live in crm/rep-kpi-reports.ts,
// which is pure; this file only fetches the rows and hands them over.
//
// SCOPE IS PASSED IN, NEVER RE-RESOLVED. The caller (getKpisBoard) has already
// resolved the viewer's reach with getDoctorCoverageScope, and this function takes
// that same object. Resolving it a second time here would put TWO independent scope
// paths on one page, which is precisely how a board ends up showing one manager
// another manager's reps — the failure is silent, because a board with too many rows
// on it looks exactly like a board with the right number of rows on it. One
// resolution, one gate, applied here with the same `isAgentInScope` the board uses.
//
// CONTACT LISTS are read directly rather than through crm/reads.ts: Phoenix's own
// list, the open periods of `crm_contact_assignments`, is not one of the tables the
// single-source door owns (it guards visits, checkins, sync runs, identity
// resolutions and plan entries), and crm/contact-lists.ts reads it the same way.
// Never the vendor scrape `ireports360_contacts`: it freezes the day the sweep is
// switched off, and every KPI denominator would freeze with it. VISITS go through the door,
// which is also what applies the departed-agent exclusion — so these numbers
// reconcile with every other CRM board rather than quietly counting reps who left.
// ─────────────────────────────────────────────────────────────────────────────

import { type CallRateHolidays } from "@/lib/crm/call-rate";
import { LIST_TYPES, type CrmListType } from "@/lib/crm/contacts-web-client";
import { isAgentInScope } from "@/lib/crm/doctor-coverage-roles";
import type { DoctorCoverageScope } from "@/lib/crm/doctor-coverage-scope";
import { queryVisits } from "@/lib/crm/reads";
import {
  buildRepKpiReports,
  CATCH_ALL_CONTACT_CRM_ID,
  resolveRepKpiStandards,
  type KpiPanelContact,
  type KpiVisitInput,
  type RepKpiReports,
  type RepKpiStandards,
} from "@/lib/crm/rep-kpi-reports";
import { CRM_CONTACT_ASSIGNMENTS_TABLE } from "@/lib/crm/tables";
import { classifyVisit } from "@/lib/crm/visit-types";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { canonicalHrIdKey } from "@/lib/hr-id";

/** PostgREST caps a page at 1000 rows; the open contact lists were 9,756 rows on 2026-09-14. */
const PAGE_SIZE = 1000;

const VISIT_COLUMNS = "agent_hr_id,contact_crm_id,visit_date,visit_type,visit_type_description,comment";

export type ContactRecord = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  contact_grade: string | null;
  list_type: string | null;
};

type VisitRecord = {
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  visit_date: string | null;
  visit_type: number | null;
  visit_type_description: string | null;
  comment: string | null;
};

/**
 * `list_type` as stored, narrowed to the three values the CRM actually emits.
 *
 * An unrecognised value is DROPPED rather than defaulted. crm/contact-lists.ts defaults an unknown
 * list to "PM" — correct there, where the caller wants every row on a list screen and a doctor list
 * is the sane default. It would be wrong here: a contact of an unknown kind silently entering the
 * DOCTOR denominator moves a coverage percentage that somebody is judged on, and nothing on the
 * screen would say it happened. Production carries exactly the three values (measured 2026-09-05),
 * so this drops nothing today; it is the behaviour on the day a fourth appears that matters.
 */
export function narrowListType(value: string | null): CrmListType | null {
  return (LIST_TYPES as readonly string[]).includes(value ?? "") ? (value as CrmListType) : null;
}

/** One open list assignment as the panel reads it — `grade` is the assignment's own column name. */
export type OpenPanelAssignment = {
  agent_crm_id: number | null;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  grade: string | null;
  list_type: string | null;
};

/** An open assignment in the panel's row shape. Pure; exported for its test. */
export function toPanelContactRecord(row: OpenPanelAssignment): ContactRecord {
  return {
    agent_crm_id: row.agent_crm_id,
    agent_hr_id: row.agent_hr_id,
    contact_crm_id: row.contact_crm_id,
    contact_grade: row.grade,
    list_type: row.list_type,
  };
}

/**
 * Every contact on every rep's list TODAY, paged: the open periods of Phoenix's own list,
 * `crm_contact_assignments` where `effective_to is null`.
 *
 * NOT `ireports360_contacts`. That is the vendor scrape; it stops moving the day the sweep is
 * switched off, and every KPI denominator built on it would freeze with it while Phoenix's own list
 * changes went uncounted. The open assignments carry the same list today — measured on production
 * 2026-09-14 before this reader moved: all 137 rep AM and PM counts identical, 7,831 contacts on
 * each side, and identical grades on every row (the assignment folds A+ into A, as the rules do).
 *
 * THE PAGES ARE FETCHED AT ONCE, not one after another — counted first so the fan-out is exact.
 * crm/contact-lists.ts does the same thing for the same reason: ~9,800 rows is ten pages, and ten
 * sequential round trips is ten times the latency on a board that already waits on four other
 * queries. The count carries the same open-period filter as the pages, or it would size the fan-out
 * for closed periods no page returns.
 *
 * An unbounded `.select()` silently stops at 1000 rows with NO marker, so the count is not an
 * optimisation here — it is the only thing that makes the read complete. A missing page would not
 * error; it would quietly shrink somebody's panel and inflate his coverage.
 */
export async function loadPanelRows(): Promise<ContactRecord[]> {
  const supabase = getSupabaseAdmin();
  const { count, error: countError } = await supabase
    .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
    .select("id", { count: "exact", head: true })
    .is("effective_to", null);
  if (countError) throw new Error(countError.message);

  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const results = await Promise.all(
    Array.from({ length: pages }, (_, page) =>
      supabase
        .from(CRM_CONTACT_ASSIGNMENTS_TABLE)
        .select("id, agent_crm_id, agent_hr_id, contact_crm_id, grade, list_type")
        .is("effective_to", null)
        // ORDERED BY `id`, the table's identity key. Range-paging over a non-unique order lets the
        // database break ties differently between pages, which silently duplicates some rows and
        // drops others. Neither shows up as an error; it just moves somebody's coverage.
        .order("id", { ascending: true })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
    ),
  );

  const rows: ContactRecord[] = [];
  for (const { data, error } of results) {
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as unknown as OpenPanelAssignment[]) rows.push(toPanelContactRecord(row));
  }
  return rows;
}

export type RepKpiReportsResult = {
  reports: RepKpiReports[];
  /**
   * Reps whose rows carry no hr id at all, so the scope gate cannot judge them and they are left
   * out. Surfaced rather than silently dropped — an unexplained missing rep reads as a data loss.
   */
  unidentifiedReps: number;
};

/**
 * Both KPI reports for every rep the viewer may see.
 *
 * A rep appears if he has a contact list OR logged a visit in the window: a rep with a list and no
 * visits is a real 0% that must be shown, and a rep with visits and NO list is the case the AM/PM
 * report exists to flag. Dropping either would make the board quietly shorter than the field force.
 */
export async function loadRepKpiReports(input: {
  scope: DoctorCoverageScope;
  dateFrom: string;
  dateTo: string;
  /**
   * The call rate's own last day, when it stops before `dateTo` — yesterday in a running window
   * (owner ruling C1). Coverage and frequency still read every visit to `dateTo`.
   */
  callRateTo?: string;
  /** Sat–Wed days in the window, holidays already removed. The call-rate denominator. */
  workingDays: number;
  holidays?: CallRateHolidays;
  /** Canonical hr id → the person's real name. A CRM handle is never shown to a human. */
  repNameByHrId?: ReadonlyMap<string, string>;
  standards?: RepKpiStandards;
  /**
   * Opt-in, DISPLAY callers only: the whole-company visit window may come from a copy up to a minute
   * old, shared by every viewer (crm/reads.ts, "A dashboard may reuse a company window"). The scope
   * gate below still runs on those rows for each viewer. Never for money, a deduction, an approval or
   * a notification.
   */
  reuseRecentWindow?: boolean;
}): Promise<RepKpiReportsResult> {
  if (input.scope.kind === "none") return { reports: [], unidentifiedReps: 0 };

  const [contactRows, visitRows] = await Promise.all([
    loadPanelRows(),
    queryVisits<VisitRecord>({
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      columns: VISIT_COLUMNS,
      collapseDoubleVisits: true,
      reuseRecentWindow: input.reuseRecentWindow === true,
    }),
  ]);

  const standards = input.standards ?? resolveRepKpiStandards(null);
  const panelByRep = new Map<string, KpiPanelContact[]>();
  const visitsByRep = new Map<string, KpiVisitInput[]>();
  let unidentifiedReps = 0;
  const unidentified = new Set<string>();

  for (const row of contactRows) {
    const key = canonicalHrIdKey(row.agent_hr_id);
    if (!key) {
      // No hr id means the scope gate cannot judge this row, so it is excluded. Failing CLOSED is
      // the only safe direction: including it would show a rep to a manager who may not own him.
      unidentified.add(`contact:${row.contact_crm_id ?? "?"}`);
      continue;
    }
    if (!isAgentInScope(input.scope, row.agent_hr_id)) continue;
    const listType = narrowListType(row.list_type);
    if (!listType || row.contact_crm_id == null) continue;
    if (row.contact_crm_id === CATCH_ALL_CONTACT_CRM_ID) continue;
    const bucket = panelByRep.get(key) ?? [];
    bucket.push({ contactCrmId: row.contact_crm_id, listType, grade: row.contact_grade });
    panelByRep.set(key, bucket);
  }

  for (const row of visitRows) {
    // REGULAR FIELD WORK ONLY — the owner, 2026-09-05: "visists to be counted from sat to wednesday
    // only regular visits". `bucket` rather than `visit_type === 0` on purpose: the vendor's
    // undocumented -30 code is real field work too and classifyVisit already routes it, so reading
    // the raw code here would drop a pharmacy call from the pharmacy report.
    if (classifyVisit(row.visit_type, row.comment, row.visit_type_description).bucket !== "regular") continue;
    const key = canonicalHrIdKey(row.agent_hr_id);
    if (!key) {
      unidentified.add(`visit:${row.agent_hr_id ?? "null"}`);
      continue;
    }
    if (!isAgentInScope(input.scope, row.agent_hr_id)) continue;
    const visitDateIso = (row.visit_date ?? "").slice(0, 10);
    if (!visitDateIso) continue;
    const bucket = visitsByRep.get(key) ?? [];
    bucket.push({ contactCrmId: row.contact_crm_id, visitDateIso });
    visitsByRep.set(key, bucket);
  }

  unidentifiedReps = unidentified.size;

  const repKeys = new Set<string>([...panelByRep.keys(), ...visitsByRep.keys()]);
  const reports: RepKpiReports[] = [];
  for (const key of repKeys) {
    reports.push(
      buildRepKpiReports({
        repHrId: key,
        repName: input.repNameByHrId?.get(key) ?? key.toUpperCase(),
        month: input.dateFrom.slice(0, 7),
        workingDays: input.workingDays,
        callRateTo: input.callRateTo,
        panel: panelByRep.get(key) ?? [],
        visits: visitsByRep.get(key) ?? [],
        standards,
        holidays: input.holidays,
      }),
    );
  }

  reports.sort((left, right) => left.repName.localeCompare(right.repName));
  return { reports, unidentifiedReps };
}
