// ─────────────────────────────────────────────────────────────────────────────
// The reads behind the plan adherence score. Rules live in plan-adherence.ts,
// which is pure; this file only fetches rows and hands them over — the same split
// crm/rep-visits.ts and crm/rep-visits-data.ts use.
//
// CRM reads go through crm/reads.ts, the mirror's single-source door, so this
// cannot silently disagree with the CRM boards that show the same visits.
// ─────────────────────────────────────────────────────────────────────────────

import { queryVisits } from "@/lib/crm/reads";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { currentCairoDateOnlyIso, formatDateValue } from "@/lib/i18n/format";
import { cairoBusinessDay } from "@/lib/phoenix-crm/calendar";
import { managerPlanAdherence } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  buildPlanAdherenceHistory,
  emptyPlanAdherenceEvidence,
  isCheckableActivity,
  isScoredInAdherenceHistory,
  mergeManagerPlanWeeks,
  scorePlanAdherence,
  type PlanAdherenceEvidence,
  type PlanAdherenceHistory,
  type PlanAdherenceHistoryEntry,
  type PlanAdherenceScore,
  type PlanItemForAdherence,
} from "@/lib/weekly-planning/plan-adherence";
import { dropPendingRevisionsOfPlansOfRecord } from "@/lib/weekly-planning/plan-revisions";

const PLAN_ITEM_COLUMNS =
  "id,plan_id,activity_date,activity_type,activity_title,double_visit_medical_rep_hr_id,double_visit_medical_rep_name";
const PLAN_HEADER_COLUMNS =
  "id,plan_kind,period_key,period_start_date,period_end_date,employee_hr_id,employee_name,status";
/** The history read also needs the link to the plan a revision revises. */
const PLAN_HISTORY_COLUMNS = `${PLAN_HEADER_COLUMNS},parent_plan_id`;
/** Only the four columns the evidence index is built from. A visit row is wide; this is not. */
const EVIDENCE_VISIT_COLUMNS =
  "agent_hr_id,agent_name,double_hr_id,double_name,double2_hr_id,double2_name,visit_date";

type PlanItemRow = {
  activity_date: string | null;
  activity_title: string | null;
  activity_type: string | null;
  double_visit_medical_rep_hr_id: string | null;
  double_visit_medical_rep_name: string | null;
  id: string;
  plan_id: string;
};

type PlanHeaderRow = {
  employee_hr_id: string | null;
  employee_name: string | null;
  id: string;
  parent_plan_id?: string | null;
  period_end_date: string | null;
  period_key: string | null;
  period_start_date: string | null;
  plan_kind: string | null;
  status: string | null;
};

type EvidenceVisitRow = {
  agent_hr_id: string | null;
  agent_name: string | null;
  double_hr_id: string | null;
  double_name: string | null;
  /** A chain visit's SECOND manager. Slot 1 is `coalesce(manager, product_manager, senior)`, so a row
   * carrying somebody here carries somebody there too — the slots never hold one person. */
  double2_hr_id: string | null;
  double2_name: string | null;
  visit_date: string | null;
};

function toPlanItem(row: PlanItemRow): PlanItemForAdherence {
  return {
    activityDate: row.activity_date,
    activityTitle: row.activity_title,
    activityType: row.activity_type,
    id: row.id,
    partnerHrId: row.double_visit_medical_rep_hr_id,
    partnerName: row.double_visit_medical_rep_name,
  };
}

/**
 * The employee roster's own spelling of a name, for the people the CRM mentions.
 *
 * The CRM's `agent_name` is a login handle dressed up — "Adel.Srour ( Down-town / C )" — and the
 * owner's standing rule is that a screen shows a person's real name, never a code or a handle. So
 * the roster is asked first and the CRM name is only the fallback for somebody the roster does not
 * have. This is the same correction the Doctor Coverage board needed (#2480).
 *
 * hr ids are sprayed across their casing variants because the mirror stores whatever casing the
 * roster happened to use and `.eq` on an hr id has silently hidden 28% of a population here before.
 */
async function loadRosterNames(hrIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const wanted = Array.from(new Set(hrIds.map((id) => id.trim().toLowerCase()).filter(Boolean)));
  if (wanted.length === 0) return names;

  const supabase = getSupabaseAdmin();
  const lookupKeys = Array.from(new Set(wanted.flatMap((id) => hrIdLookupKeys(id))));
  // Chunked at 50: a PostgREST `.in()` carrying several hundred values goes in the URL and past some
  // length returns `{ data: [], error: null }` — an empty set indistinguishable from a true answer.
  for (let start = 0; start < lookupKeys.length; start += 50) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id, full_name, nickname")
      .in("hr_id", lookupKeys.slice(start, start + 50));
    if (error) continue;
    for (const row of (data ?? []) as Array<{ full_name: string | null; hr_id: string | null; nickname: string | null }>) {
      const key = row.hr_id?.trim().toLowerCase();
      const name = row.full_name?.trim();
      if (key && name) names.set(key, resolveEmployeeDisplayName(name, row.nickname, row.hr_id));
    }
  }
  return names;
}

/**
 * What the CRM recorded about one person's days, in the window their plans cover.
 *
 * Three reads rather than one, because the question "was the plan owner out that day" has to be
 * answered whichever side of the visit he sits on — a manager appears as `agent_hr_id` on his own
 * calls and as `double_hr_id` on a rep's. PostgREST ANDs its filters, so one query cannot ask for
 * either; two can.
 *
 * `includeResignedAgents` is ON deliberately. The default exclusion is right for a live board — a
 * departed rep should not appear in today's coverage — but this read is about whether a day that
 * has already happened happened. A manager who genuinely went out with a rep who has since resigned
 * kept his plan, and hiding that visit would score him as `no_trace` for turning up.
 */
export async function loadPlanAdherenceEvidence(
  ownerHrId: string | null | undefined,
  partnerHrIds: readonly string[],
  dateFrom: string,
  dateTo: string,
): Promise<PlanAdherenceEvidence> {
  const owner = ownerHrId?.trim();
  if (!owner || !dateFrom || !dateTo) return emptyPlanAdherenceEvidence();

  const partners = Array.from(new Set(partnerHrIds.map((id) => id?.trim()).filter((id): id is string => Boolean(id))));

  const [asAgent, asDouble, partnerDays] = await Promise.all([
    queryVisits<EvidenceVisitRow>({
      agentHrIds: [owner],
      columns: EVIDENCE_VISIT_COLUMNS,
      dateFrom,
      dateTo,
      includeResignedAgents: true,
    }),
    queryVisits<EvidenceVisitRow>({
      columns: EVIDENCE_VISIT_COLUMNS,
      dateFrom,
      dateTo,
      doubleHrIds: [owner],
      includeResignedAgents: true,
    }),
    partners.length > 0
      ? queryVisits<EvidenceVisitRow>({
          agentHrIds: partners,
          columns: EVIDENCE_VISIT_COLUMNS,
          dateFrom,
          dateTo,
          includeResignedAgents: true,
        })
      : Promise.resolve([] as EvidenceVisitRow[]),
  ]);

  const ownerActiveDates = new Set<string>();
  const ownerPartnersByDate = new Map<string, Set<string>>();
  const personActiveDayKeys = new Set<string>();
  const crmNameByHrId = new Map<string, string>();

  function remember(hrId: string | null, name: string | null): void {
    const key = hrId?.trim().toLowerCase();
    const label = name?.trim();
    if (key && label && !crmNameByHrId.has(key)) crmNameByHrId.set(key, label);
  }

  function noteOwnerDay(date: string | null, partnerHrId: string | null): void {
    const day = date?.slice(0, 10);
    if (!day) return;
    ownerActiveDates.add(day);
    const partner = partnerHrId?.trim().toLowerCase();
    if (!partner) return;
    let bucket = ownerPartnersByDate.get(day);
    if (!bucket) {
      bucket = new Set<string>();
      ownerPartnersByDate.set(day, bucket);
    }
    bucket.add(partner);
  }

  // `ownerPartnersByDate` is a SET per day, so naming the chain visit's second manager as well can
  // never inflate a count — it only stops one of the two people he rode with going unnamed.
  for (const row of asAgent) {
    for (const [hrId, name] of [
      [row.double_hr_id, row.double_name],
      [row.double2_hr_id, row.double2_name],
    ] as const) {
      noteOwnerDay(row.visit_date, hrId);
      remember(hrId, name);
    }
  }
  for (const row of asDouble) {
    // Roles reversed: the owner is a ride-along partner here, so the OTHER people on the row are the
    // agent and — on a chain visit — the manager in the slot the owner is not in.
    for (const [hrId, name] of [
      [row.agent_hr_id, row.agent_name],
      [row.double_hr_id, row.double_name],
      [row.double2_hr_id, row.double2_name],
    ] as const) {
      noteOwnerDay(row.visit_date, hrId);
      remember(hrId, name);
    }
  }
  for (const row of [...asAgent, ...asDouble, ...partnerDays]) {
    const day = row.visit_date?.slice(0, 10);
    const agent = row.agent_hr_id?.trim().toLowerCase();
    if (day && agent) personActiveDayKeys.add(`${day}|${agent}`);
    remember(row.agent_hr_id, row.agent_name);
  }

  const rosterNames = await loadRosterNames([...crmNameByHrId.keys(), ...partners.map((id) => id.toLowerCase())]);
  const nameByHrId = new Map<string, string>(crmNameByHrId);
  for (const [key, name] of rosterNames) nameByHrId.set(key, name);

  return { nameByHrId, ownerActiveDates, ownerPartnersByDate, personActiveDayKeys };
}

/** The widest date span a set of items covers, so one evidence read serves all of them. */
function itemDateWindow(items: readonly PlanItemForAdherence[]): { from: string; to: string } | null {
  const dates = items
    .map((item) => item.activityDate?.slice(0, 10))
    .filter((date): date is string => Boolean(date))
    .sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  return from && to ? { from, to } : null;
}

/**
 * Score every plan a person owns, in one pass.
 *
 * Batched on purpose: the approvals hub renders a list of plans and the portal dashboard renders a
 * team, so a per-plan read would be one CRM scan per row. One evidence read covers the whole span
 * because the evidence is indexed by day, not by plan.
 */
export async function loadPlanAdherenceForPlans(
  planIds: readonly string[],
): Promise<Map<string, PlanAdherenceScore>> {
  const scores = new Map<string, PlanAdherenceScore>();
  const ids = Array.from(new Set(planIds.filter(Boolean)));
  if (ids.length === 0) return scores;

  const supabase = getSupabaseAdmin();
  const headers: PlanHeaderRow[] = [];
  const items: PlanItemRow[] = [];
  for (let start = 0; start < ids.length; start += 50) {
    const slice = ids.slice(start, start + 50);
    const [headerRes, itemRes] = await Promise.all([
      supabase.from("employee_plan_headers").select(PLAN_HEADER_COLUMNS).in("id", slice),
      supabase.from("employee_plan_items").select(PLAN_ITEM_COLUMNS).in("plan_id", slice),
    ]);
    if (headerRes.error || itemRes.error) return scores;
    headers.push(...((headerRes.data ?? []) as PlanHeaderRow[]));
    items.push(...((itemRes.data ?? []) as PlanItemRow[]));
  }

  const itemsByPlan = new Map<string, PlanItemForAdherence[]>();
  for (const row of items) {
    const bucket = itemsByPlan.get(row.plan_id);
    if (bucket) bucket.push(toPlanItem(row));
    else itemsByPlan.set(row.plan_id, [toPlanItem(row)]);
  }

  // One evidence read per owner, not per plan: a person's plans overlap in time and share days.
  const plansByOwner = new Map<string, PlanHeaderRow[]>();
  for (const header of headers) {
    const owner = header.employee_hr_id?.trim().toLowerCase();
    if (!owner) continue;
    const bucket = plansByOwner.get(owner);
    if (bucket) bucket.push(header);
    else plansByOwner.set(owner, [header]);
  }

  await Promise.all(
    Array.from(plansByOwner.entries()).map(async ([owner, ownerPlans]) => {
      const ownerItems = ownerPlans.flatMap((plan) => itemsByPlan.get(plan.id) ?? []);
      const window = itemDateWindow(ownerItems);
      const evidence = window
        ? await loadPlanAdherenceEvidence(
            owner,
            ownerItems
              .filter((item) => isCheckableActivity(item.activityType))
              .map((item) => item.partnerHrId)
              .filter((id): id is string => Boolean(id)),
            window.from,
            window.to,
          )
        : emptyPlanAdherenceEvidence();

      for (const plan of ownerPlans) {
        scores.set(plan.id, scorePlanAdherence(itemsByPlan.get(plan.id) ?? [], evidence));
      }
    }),
  );

  return scores;
}

/** One plan's score, for the drill-down that shows where the mismatch is. */
export async function loadPlanAdherence(planId: string): Promise<PlanAdherenceScore | null> {
  const scores = await loadPlanAdherenceForPlans([planId]);
  return scores.get(planId) ?? null;
}

/**
 * One person's score history, newest first — the extra approvals tab.
 *
 * Which plans are left out (drafts, cancelled and rejected plans) is
 * PLAN_ADHERENCE_HISTORY_EXCLUDED_STATUSES in plan-adherence.ts, where the reason is written down.
 */
export async function loadPlanAdherenceHistory(
  employeeHrId: string | null | undefined,
  options: { limit?: number; planKind?: string } = {},
): Promise<PlanAdherenceHistory> {
  const hrId = employeeHrId?.trim();
  if (!hrId) return buildPlanAdherenceHistory([]);

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employee_plan_headers")
    .select(PLAN_HISTORY_COLUMNS)
    .in("employee_hr_id", hrIdLookupKeys(hrId))
    .eq("plan_kind", options.planKind ?? "weekly")
    .order("period_start_date", { ascending: false })
    .limit(options.limit ?? 26);
  if (error) return buildPlanAdherenceHistory([]);

  // A revision still waiting for its decisions is left out while the approved plan it revises is in
  // the same history: the week is scored once, on the plan of record.
  const plansOfTheWeek = dropPendingRevisionsOfPlansOfRecord((data ?? []) as PlanHeaderRow[]);
  const headers = plansOfTheWeek.filter((header) => isScoredInAdherenceHistory(header.status));
  if (headers.length === 0) return buildPlanAdherenceHistory([]);

  const scores = await loadPlanAdherenceForPlans(headers.map((header) => header.id));
  const entries: PlanAdherenceHistoryEntry[] = [];
  for (const header of headers) {
    const score = scores.get(header.id);
    if (!score) continue;
    entries.push({
      checkable: score.checkable,
      kept: score.kept,
      measurable: score.measurable,
      periodEndDate: header.period_end_date ?? "",
      periodKey: header.period_key ?? "",
      periodStartDate: header.period_start_date ?? "",
      planId: header.id,
      scorePct: score.scorePct,
      status: header.status ?? "",
    });
  }
  return buildPlanAdherenceHistory(entries);
}

/**
 * The dashboard headline: this person's most recent scored plan, plus their running average.
 *
 * `latest` is the newest MEASURABLE period, not simply the newest — a manager whose last week was
 * all office days would otherwise open his dashboard to "Not measured" and learn nothing, when the
 * week before it has a real number worth seeing. `latestIsStale` says so, so the card can name the
 * period rather than imply the score is current.
 *
 * Returns null for anyone who has never filed a plan. That is most of the company: the plan module
 * is managers only, and a card reading "no score" on 400 dashboards is noise, not information.
 */
export type PortalPlanAdherence = {
  averagePct: number | null;
  latest: PlanAdherenceHistoryEntry | null;
  measuredPeriods: number;
  totalPeriods: number;
};

export async function loadPortalPlanAdherence(
  employeeHrId: string | null | undefined,
): Promise<PortalPlanAdherence | null> {
  const [legacy, crmWeeks] = await Promise.all([
    loadPlanAdherenceHistory(employeeHrId, { limit: 12 }),
    loadPhoenixCrmManagerWeeks(employeeHrId),
  ]);
  const history = crmWeeks.length > 0 ? mergeManagerPlanWeeks(legacy.entries, crmWeeks) : legacy;
  if (history.entries.length === 0) return null;
  return {
    averagePct: history.averagePct,
    latest: history.entries.find((entry) => entry.measurable) ?? history.entries[0] ?? null,
    measuredPeriods: history.measuredPeriods,
    totalPeriods: history.entries.length,
  };
}

/**
 * A district manager's Phoenix CRM weeks, scored for the same card (owner, 2026-10-16: his Phoenix CRM
 * week REPLACES the legacy plan once his team is live). A customer he planned counts once his day has
 * closed — kept when the rep logged the visit naming him (with a rep) or he logged it himself (a single
 * visit); admin half-days are not checkable. The card links to the Approvals Hub's plan page, which opens
 * a Phoenix CRM plan id too. A failed read adds nothing: the legacy weeks still show.
 */
async function loadPhoenixCrmManagerWeeks(employeeHrId: string | null | undefined): Promise<PlanAdherenceHistoryEntry[]> {
  if (!employeeHrId?.trim()) return [];
  try {
    const weeks = await managerPlanAdherence(employeeHrId, { cairoToday: currentCairoDateOnlyIso(), visitDay: cairoBusinessDay(new Date()) });
    return weeks.map((week) => ({
      checkable: week.checkable,
      kept: week.kept,
      measurable: week.checkable > 0,
      periodEndDate: week.weekEnd,
      periodKey: `Week of ${formatDateValue(week.weekStart)}`,
      periodStartDate: week.weekStart,
      planId: week.planId,
      scorePct: week.scorePct,
      status: week.status,
    }));
  } catch {
    return [];
  }
}
