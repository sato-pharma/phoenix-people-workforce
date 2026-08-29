/**
 * Reads for the Plan Verification board — the plans a manager may verify, grouped as PLANS rather
 * than as the thousands of individual planned calls the mirror stores.
 *
 * A plan is one rep, one period, and one approval status. `ireports360_plan_entries` holds one row
 * per planned CALL, so a single weekly plan is 76-193 rows and a month of them is ~25,000. Every
 * screen in this feature is about the plan, never the row, so the grouping happens here once.
 *
 * Verified against production 2026-08-28: 2,388 weekly plans, and `plan_status` is constant within
 * every one of them — 2,388 of 2,388 carry exactly one distinct status. The vendor's own monthly
 * feed behaves the same way (17 August plans, 21 July, none with mixed status, none spanning two
 * agents). So treating the status as a property of the PLAN is not an assumption; it is measured.
 *
 * ## The month-boundary trap
 *
 * 265 of those 2,388 weekly plans (11%) straddle a month boundary — a week running 30 August to
 * 5 September. Filtering entries by `plan_date BETWEEN month start AND month end` therefore splits
 * such a plan in two and shows a manager half of it, twice, with a doctor count that is wrong in
 * both places. So the fetch window is deliberately WIDER than the month and a plan is assigned to
 * the month its FIRST day falls in. See `PLAN_STRADDLE_MARGIN_DAYS`.
 *
 * ## Monthly plans are not weekly plans
 *
 * A monthly plan has no dates at all — it says "see this doctor `frequency` times this month". It
 * is keyed on `plan_month`/`plan_year`, so it needs its own query, and any date-ranged read drops
 * every monthly row silently. That is why `kind` is a required argument here rather than a filter
 * applied afterwards.
 */

import { CRM_PLAN_ENTRIES_TABLE } from "@/lib/crm/tables";
import { getAgentContactList, getDoctorListRepSummaries } from "@/lib/crm/contact-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { PLAN_STATUS_NEW, type PlanKind } from "@/lib/crm/plan-verification";
import { scopeAllowsAgent, type PlanVerificationScope } from "@/lib/crm/plan-verification-access";

/** PostgREST caps a page at 1000 rows and gives no marker when it truncates. */
const PAGE_SIZE = 1000;

/**
 * How far past the month end the weekly fetch reaches, so a plan starting inside the month is
 * always fetched whole.
 *
 * Measured 2026-08-28: no weekly plan in production spans more than 7 days, and none is longer than
 * a week. 14 is double that on purpose — the cost of the margin is a few hundred extra rows, and
 * the cost of it being too small is a plan silently missing its last days.
 */
export const PLAN_STRADDLE_MARGIN_DAYS = 14;

/** Ids per `.in()` filter. A long list travels in the URL and comes back `{ data: [], error: null }`
 * — an empty set indistinguishable from a true answer. */
const IN_CHUNK = 50;

export type PlanSummary = {
  agentCrmId: number;
  agentHrId: string | null;
  /** Distinct doctors on the plan. Not the same as `entries`: a weekly plan can list one doctor on
   * two days, and a monthly plan carries a frequency instead of repeating the row. */
  contacts: number;
  crmPlanId: number;
  entries: number;
  /** Weekly only — the plan's first and last planned day. Null on a monthly plan, which has none. */
  firstDate: string | null;
  kind: PlanKind;
  lastDate: string | null;
  /** Monthly only. */
  month: number | null;
  repName: string;
  status: number | null;
  syncedAt: string | null;
  year: number | null;
};

export type PlanEntryRow = {
  /**
   * Where the doctor is, taken from the rep's own assigned list — the SAME source tab one prints,
   * so the two tabs can never disagree about one doctor. The plan itself carries no address: the
   * vendor's plan payload has none, and the Reporting API has no contacts endpoint at all, so this
   * is Phoenix's own mirror of the CRM web app's contact grid.
   *
   * Null on two different facts, which `onRepList` separates — see below.
   */
  address: string | null;
  ampm: string | null;
  contactCrmId: number | null;
  contactName: string;
  /** Monthly only — planned calls on this doctor for the month. */
  frequency: number | null;
  grade: string | null;
  /**
   * Whether this doctor is on the rep's CURRENT assigned list.
   *
   * Exists so a blank address can say WHICH blank it is. Measured in production 2026-08-28 across
   * August's weekly plans: of 9,769 doctor-plan pairs, 7,687 (78.7%) carry an address, 286 are on
   * the rep's list with no address recorded, and 1,796 are planned against a doctor who is not on
   * his current list at all. Those are different facts — the second is a CRM data gap, the first is
   * a rep planning outside his own assignment — and rendering both as a dash would hide the more
   * interesting one, which is precisely the sort of thing a manager is verifying the plan FOR.
   *
   * False also when the contact mirror could not be read; the board then shows no address anywhere,
   * which reads as the mirror being unavailable rather than as every rep planning off-list.
   */
  onRepList: boolean;
  planDate: string | null;
  region: string | null;
  speciality: string | null;
};

type RawPlanRow = {
  agent_crm_id: number;
  agent_hr_id: string | null;
  contact_crm_id: number | null;
  crm_plan_id: number | null;
  plan_date: string | null;
  plan_month: number | null;
  plan_status: number | null;
  plan_year: number | null;
  synced_at: string | null;
};

/** The plan mirror is newer than several environments' schemas; a missing table degrades to an
 * empty board rather than a crash page, matching every other CRM reader's posture. */
function isPlanSchemaMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message ?? "");
  return (
    message.includes(CRM_PLAN_ENTRIES_TABLE) &&
    (message.includes("does not exist") || message.includes("schema cache"))
  );
}

function addDays(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** First and last day of a Cairo calendar month, as plain ISO dates. */
export function monthBounds(month: number, year: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  // Day 0 of the next month is the last day of this one; Date.UTC normalises December.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`, start };
}

/**
 * Groups raw entry rows into one summary per plan.
 *
 * Pure, so the month-assignment rule and the "one plan, one status" invariant can be tested against
 * fixtures without a database. A row carrying no `crm_plan_id` is dropped: it belongs to no plan, so
 * there is nothing a manager could verify, and inventing a synthetic group for it would put an
 * unverifiable card on the board.
 *
 * `keepMonth` applies the straddle rule — a weekly plan belongs to the month its FIRST day falls
 * in, so a plan fetched only because it reaches into the window is discarded here rather than shown
 * half-complete.
 */
export function summarisePlans(
  rows: readonly RawPlanRow[],
  input: { kind: PlanKind; keepMonth?: { month: number; year: number } },
): PlanSummary[] {
  const byPlan = new Map<number, PlanSummary & { contactIds: Set<number> }>();
  for (const row of rows) {
    if (row.crm_plan_id == null) continue;
    let plan = byPlan.get(row.crm_plan_id);
    if (!plan) {
      plan = {
        agentCrmId: row.agent_crm_id,
        agentHrId: row.agent_hr_id,
        contactIds: new Set<number>(),
        contacts: 0,
        crmPlanId: row.crm_plan_id,
        entries: 0,
        firstDate: null,
        kind: input.kind,
        lastDate: null,
        month: row.plan_month,
        repName: "",
        status: row.plan_status,
        syncedAt: row.synced_at,
        year: row.plan_year,
      };
      byPlan.set(row.crm_plan_id, plan);
    }
    plan.entries += 1;
    if (row.contact_crm_id != null) plan.contactIds.add(row.contact_crm_id);
    if (row.plan_date) {
      if (!plan.firstDate || row.plan_date < plan.firstDate) plan.firstDate = row.plan_date;
      if (!plan.lastDate || row.plan_date > plan.lastDate) plan.lastDate = row.plan_date;
    }
    // Latest sync stamp across the plan's rows, so "last refreshed" is honest for the whole plan.
    if (row.synced_at && (!plan.syncedAt || row.synced_at > plan.syncedAt)) plan.syncedAt = row.synced_at;
  }

  const summaries: PlanSummary[] = [];
  for (const plan of byPlan.values()) {
    const { contactIds, ...rest } = plan;
    const summary: PlanSummary = { ...rest, contacts: contactIds.size };
    if (input.keepMonth && summary.firstDate) {
      const bounds = monthBounds(input.keepMonth.month, input.keepMonth.year);
      // The straddle rule: a plan belongs to the month it STARTS in, and only that month.
      if (summary.firstDate < bounds.start || summary.firstDate > bounds.end) continue;
    }
    summaries.push(summary);
  }

  // Pending first — the board exists to clear a backlog, and the owner's standing rule is that a
  // screen answers its own question without the reader sorting it. Then newest, then rep name.
  summaries.sort((left, right) => {
    const leftPending = left.status === PLAN_STATUS_NEW ? 0 : 1;
    const rightPending = right.status === PLAN_STATUS_NEW ? 0 : 1;
    if (leftPending !== rightPending) return leftPending - rightPending;
    const leftKey = left.firstDate ?? "";
    const rightKey = right.firstDate ?? "";
    if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
    return left.repName.localeCompare(right.repName);
  });
  return summaries;
}

const SUMMARY_COLUMNS =
  "agent_crm_id, agent_hr_id, contact_crm_id, crm_plan_id, plan_date, plan_month, plan_status, plan_year, synced_at";

/** Reads every summary-shaped row for one period, paged. Scope is applied IN SQL, not afterwards. */
async function fetchSummaryRows(input: {
  kind: PlanKind;
  month: number;
  year: number;
  scope: PlanVerificationScope;
}): Promise<RawPlanRow[]> {
  const supabase = getSupabaseAdmin();
  const bounds = monthBounds(input.month, input.year);

  // A scoped viewer's allow-list is chunked because a long `.in()` silently returns nothing.
  // A company-scoped viewer runs one unfiltered pass.
  const chunks: Array<readonly string[] | null> = [];
  if (input.scope.kind === "agents") {
    for (let from = 0; from < input.scope.agentHrIds.length; from += IN_CHUNK) {
      chunks.push(input.scope.agentHrIds.slice(from, from + IN_CHUNK));
    }
  } else {
    chunks.push(null);
  }

  const rows: RawPlanRow[] = [];
  for (const chunk of chunks) {
    let offset = 0;
    for (;;) {
      let query = supabase.from(CRM_PLAN_ENTRIES_TABLE).select(SUMMARY_COLUMNS).eq("plan_kind", input.kind);
      if (input.kind === "weekly") {
        // Wider than the month on purpose — see PLAN_STRADDLE_MARGIN_DAYS. `summarisePlans` throws
        // away anything that does not START inside the month.
        query = query
          .gte("plan_date", addDays(bounds.start, -PLAN_STRADDLE_MARGIN_DAYS))
          .lte("plan_date", addDays(bounds.end, PLAN_STRADDLE_MARGIN_DAYS));
      } else {
        query = query.eq("plan_month", input.month).eq("plan_year", input.year);
      }
      if (chunk) query = query.in("agent_hr_id", [...chunk]);
      const { data, error } = await query
        .order("crm_plan_entry_id", { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);
      if (error) {
        if (isPlanSchemaMissing(error)) return [];
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as RawPlanRow[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }
  return rows;
}

/**
 * The address of every doctor on one rep's assigned list, keyed by CRM contact id.
 *
 * Read per AGENT rather than per contact id on purpose. The alternative — an `.in()` over the
 * plan's contact ids — is the shape that returns `{ data: [], error: null }` once the URL grows
 * long enough, and a plan can carry 120 doctors; an empty answer there would silently blank the
 * address column on the largest plans, which are exactly the ones a manager most needs to read.
 * One agent's list is a bounded paged read the Doctor List tab already performs.
 *
 * Never throws. An address is context beside the doctor's name, not the record itself — failing the
 * whole plan because the contact mirror was unreachable would hide the plan a manager came to sign.
 */
async function addressesForAgent(
  agentCrmId: number | null,
): Promise<{ byContactId: Map<number, string>; onList: Set<number> }> {
  const byContactId = new Map<number, string>();
  const onList = new Set<number>();
  if (agentCrmId == null) return { byContactId, onList };
  try {
    for (const contact of await getAgentContactList(agentCrmId)) {
      onList.add(contact.contactCrmId);
      const address = contact.address?.trim();
      if (address) byContactId.set(contact.contactCrmId, address);
    }
  } catch {
    // Both cleared together, deliberately. A half-read list would report doctors as "not on his
    // list" on the strength of a failed query, which is an accusation, not a gap.
    return { byContactId: new Map(), onList: new Set() };
  }
  return { byContactId, onList };
}

/** The doctors on ONE plan, with the contact detail the summary query deliberately skips. */
export async function getPlanEntries(crmPlanId: number, agentCrmId?: number | null): Promise<PlanEntryRow[]> {
  const supabase = getSupabaseAdmin();
  const { byContactId: addresses, onList } = await addressesForAgent(agentCrmId ?? null);
  const rows: PlanEntryRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from(CRM_PLAN_ENTRIES_TABLE)
      .select("ampm, contact_crm_id, contact_grade, contact_name, crm_region_name, plan_date, plan_frequency, speciality")
      .eq("crm_plan_id", crmPlanId)
      .order("plan_date", { ascending: true, nullsFirst: true })
      .order("contact_name", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) {
      if (isPlanSchemaMissing(error)) return [];
      throw new Error(error.message);
    }
    const page = (data ?? []) as unknown as Array<{
      ampm: string | null;
      contact_crm_id: number | null;
      contact_grade: string | null;
      contact_name: string | null;
      crm_region_name: string | null;
      plan_date: string | null;
      plan_frequency: number | null;
      speciality: string | null;
    }>;
    for (const row of page) {
      rows.push({
        address: row.contact_crm_id == null ? null : addresses.get(row.contact_crm_id) ?? null,
        ampm: row.ampm,
        contactCrmId: row.contact_crm_id,
        // A nameless contact is shown by its CRM id rather than as a blank cell — the owner's rule
        // is that a screen never shows nothing where a value is missing.
        contactName: row.contact_name?.trim() || `Contact ${row.contact_crm_id ?? "unknown"}`,
        frequency: row.plan_frequency,
        grade: row.contact_grade,
        onRepList: row.contact_crm_id != null && onList.has(row.contact_crm_id),
        planDate: row.plan_date,
        region: row.crm_region_name,
        speciality: row.speciality,
      });
    }
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return rows;
}

/**
 * One plan's identity, read fresh.
 *
 * The verify route calls this immediately before writing, rather than trusting anything the browser
 * posted. Two things depend on it: the scope check (is this rep mine?) and the status check (is this
 * plan still pending?). Both must be answered from the database at the moment of the write — a
 * board rendered ten minutes ago is not evidence about either.
 */
export async function getPlanForVerification(crmPlanId: number): Promise<{
  agentCrmId: number;
  agentHrId: string | null;
  /** Weekly only — the plan's span, so the rep's notification can name the week it covers. */
  firstDate: string | null;
  kind: PlanKind;
  lastDate: string | null;
  month: number | null;
  status: number | null;
  year: number | null;
} | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from(CRM_PLAN_ENTRIES_TABLE)
    .select("agent_crm_id, agent_hr_id, plan_kind, plan_month, plan_status, plan_year")
    .eq("crm_plan_id", crmPlanId)
    .limit(1);
  if (error) {
    if (isPlanSchemaMissing(error)) return null;
    throw new Error(error.message);
  }
  const row = (data ?? [])[0] as
    | {
        agent_crm_id: number;
        agent_hr_id: string | null;
        plan_kind: string;
        plan_month: number | null;
        plan_status: number | null;
        plan_year: number | null;
      }
    | undefined;
  if (!row) return null;
  const kind: PlanKind = row.plan_kind === "monthly" ? "monthly" : "weekly";

  // A weekly plan's period is its date span, and the rep's notification names it. Two limit-1 reads
  // rather than pulling the plan's ~100 rows to compute a min and a max the database can answer.
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  if (kind === "weekly") {
    const [first, last] = await Promise.all([
      supabase
        .from(CRM_PLAN_ENTRIES_TABLE)
        .select("plan_date")
        .eq("crm_plan_id", crmPlanId)
        .not("plan_date", "is", null)
        .order("plan_date", { ascending: true })
        .limit(1),
      supabase
        .from(CRM_PLAN_ENTRIES_TABLE)
        .select("plan_date")
        .eq("crm_plan_id", crmPlanId)
        .not("plan_date", "is", null)
        .order("plan_date", { ascending: false })
        .limit(1),
    ]);
    firstDate = ((first.data ?? [])[0] as { plan_date: string | null } | undefined)?.plan_date ?? null;
    lastDate = ((last.data ?? [])[0] as { plan_date: string | null } | undefined)?.plan_date ?? null;
  }

  return {
    agentCrmId: row.agent_crm_id,
    agentHrId: row.agent_hr_id,
    firstDate,
    kind,
    lastDate,
    month: row.plan_month,
    status: row.plan_status,
    year: row.plan_year,
  };
}

/** A rep in the viewer's reach who filed no plan at all for the period. */
export type PlanMissingRep = {
  agentCrmId: number;
  hrId: string | null;
  name: string;
  /** His assigned PM list size — evidence this is a working account rather than a dormant one. */
  pmCount: number;
};

/**
 * Which reps in reach have no plan this period.
 *
 * Pure, so the rule is testable without a database. Matching is on the numeric CRM agent id, NEVER
 * on `hr_id`: hr ids are mixed case in this database, so a case-sensitive comparison silently
 * under-matches and would report a rep who DID file as having filed nothing — an accusation, and the
 * worst possible direction for this particular error to fall in.
 */
export function repsWithNoPlan(input: {
  plans: readonly Pick<PlanSummary, "agentCrmId">[];
  roster: readonly PlanMissingRep[];
}): PlanMissingRep[] {
  const filed = new Set(input.plans.map((plan) => plan.agentCrmId));
  return input.roster
    .filter((rep) => !filed.has(rep.agentCrmId))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export type PlanVerificationBoard = {
  kind: PlanKind;
  /**
   * Reps in reach with NO plan for this period. The board otherwise cannot show them at all: it is
   * built from plans that exist, so a rep who filed nothing is absent rather than flagged, and
   * "reps with a plan: 12" reads as complete whether the true roster is 12 or 30.
   */
  missingReps: PlanMissingRep[];
  month: number;
  plans: PlanSummary[];
  /**
   * False when the CRM contact-list mirror returned no reps at all — it is scraped from the CRM's web
   * app, so it can be empty or stale for reasons that have nothing to do with planning. The board
   * then says the roster is unavailable rather than reporting zero missing, which would be a false
   * all-clear indistinguishable from a healthy month.
   */
  rosterKnown: boolean;
  /** The plan whose doctors are on screen, with its rows. Null when none is chosen or in scope. */
  selected: { plan: PlanSummary; rows: PlanEntryRow[] } | null;
  /** What the viewer's reach is, in words — shown so a short list is never mistaken for a quiet CRM. */
  scopeLabel: string;
  /** Set when the viewer resolves to nobody; the board then explains rather than showing an empty list. */
  scopeReason: string | null;
  year: number;
};

/**
 * Assembles the board.
 *
 * Rep names are resolved here because the owner's standing rule is that a screen never shows a raw
 * code, and an agent id is exactly that. A plan whose agent the identity waterfall could not resolve
 * is LABELLED as unresolved rather than hidden — for a company-scoped viewer that is a finding worth
 * seeing, and a scoped viewer never receives one at all (see `scopeAllowsAgent`).
 */
export async function getPlanVerificationBoard(input: {
  kind: PlanKind;
  month: number;
  scope: PlanVerificationScope;
  selectedPlanId?: number;
  year: number;
}): Promise<PlanVerificationBoard> {
  const base = {
    kind: input.kind,
    missingReps: [] as PlanMissingRep[],
    month: input.month,
    plans: [] as PlanSummary[],
    rosterKnown: false,
    selected: null,
    scopeLabel: input.scope.kind === "none" ? "No reach" : input.scope.label,
    scopeReason: input.scope.kind === "none" ? input.scope.reason : null,
    year: input.year,
  } satisfies PlanVerificationBoard;

  if (input.scope.kind === "none") return base;

  const rows = await fetchSummaryRows({
    kind: input.kind,
    month: input.month,
    scope: input.scope,
    year: input.year,
  });
  const plans = summarisePlans(rows, {
    kind: input.kind,
    ...(input.kind === "weekly" ? { keepMonth: { month: input.month, year: input.year } } : {}),
  });

  const hrIds = [...new Set(plans.map((plan) => plan.agentHrId).filter((id): id is string => Boolean(id)))];
  const nameByHrId = new Map<string, string>();
  for (let from = 0; from < hrIds.length; from += IN_CHUNK) {
    const chunk = hrIds.slice(from, from + IN_CHUNK);
    const { data, error } = await getSupabaseAdmin().from("employees").select("hr_id, full_name").in("hr_id", chunk);
    if (error) throw new Error(`Could not read rep names: ${error.message}`);
    for (const row of data ?? []) nameByHrId.set(row.hr_id as string, (row.full_name as string) ?? "");
  }
  for (const plan of plans) {
    plan.repName =
      (plan.agentHrId ? nameByHrId.get(plan.agentHrId) : "") || `CRM account ${plan.agentCrmId} — not on the roster`;
  }
  // Re-sort now that names exist; the pure sort ran before they were resolved.
  plans.sort((left, right) => {
    const leftPending = left.status === PLAN_STATUS_NEW ? 0 : 1;
    const rightPending = right.status === PLAN_STATUS_NEW ? 0 : 1;
    if (leftPending !== rightPending) return leftPending - rightPending;
    const leftKey = left.firstDate ?? "";
    const rightKey = right.firstDate ?? "";
    if (leftKey !== rightKey) return rightKey.localeCompare(leftKey);
    return left.repName.localeCompare(right.repName);
  });

  // A hand-typed plan id outside the viewer's reach must resolve to nothing, exactly as if it did
  // not exist. The list is already scoped, so membership of it IS the check.
  const chosen = input.selectedPlanId
    ? (plans.find((plan) => plan.crmPlanId === input.selectedPlanId) ?? null)
    : null;
  // The agent id is passed so the doctors carry their addresses: the plan rows hold none, and the
  // address lives on the rep's assigned list, which is keyed by agent.
  const selected = chosen ? { plan: chosen, rows: await getPlanEntries(chosen.crmPlanId, chosen.agentCrmId) } : null;

  // WHO SHOULD HAVE FILED comes from the same source tab one uses for its rep picker — the CRM's own
  // assigned-contact mirror, filtered by the same scopeAllowsAgent. Sharing tab one's source means
  // the two tabs of one page can never disagree about who a manager's reps are.
  //
  // The two rejected alternatives, both measured against production on 2026-08-29 rather than
  // reasoned about:
  //
  // A JOB-TITLE match on the employee directory. `job_title ilike '%medical rep%'` returns ZERO rows
  // in production — the titles simply are not spelled that way — and the same inconsistency once hid
  // 9 of 27 district managers from a search. A roster that quietly omits a rep produces exactly the
  // silence this feature exists to break.
  //
  // The UNION of the mirror with everyone who filed a plan in the preceding three months. It sounds
  // strictly better and is much worse: for August it produced 23 names against the mirror's 3, and
  // of the 20 extra, 18 were CRM accounts with no employee row at all and 2 were reps who had
  // resigned. Twenty rows of noise would bury three real ones on the screen a manager is meant to
  // act from.
  //
  // What the mirror costs, stated honestly: it held 68 agents while 79 filed an August plan, so 14
  // agents the CRM plans for are absent from it. Those cannot appear here. That direction is the
  // safe one — an absent agent is never falsely accused — but it does mean this list is a floor, not
  // a complete census, and it grows as the contact mirror is scraped for more reps.
  const roster = (await getDoctorListRepSummaries())
    .filter((rep) => scopeAllowsAgent(input.scope, rep.hrId))
    .map<PlanMissingRep>((rep) => ({
      agentCrmId: rep.agentCrmId,
      hrId: rep.hrId,
      name: rep.name,
      pmCount: rep.pmCount,
    }));
  // Names AND employment status, in one read of its own rather than by topping up the map built for
  // the plans above: a reused CRM slot puts two agent ids on one hr id, so "already resolved" is not
  // a safe reason to skip an id here.
  const missingBeforeNames = repsWithNoPlan({ plans, roster });
  const missingHrIds = [...new Set(missingBeforeNames.map((rep) => rep.hrId).filter((id): id is string => Boolean(id)))];
  const employeeByHrId = new Map<string, { name: string; status: string | null }>();
  for (let from = 0; from < missingHrIds.length; from += IN_CHUNK) {
    const chunk = missingHrIds.slice(from, from + IN_CHUNK);
    const { data, error } = await getSupabaseAdmin()
      .from("employees")
      .select("hr_id, full_name, employment_status")
      .in("hr_id", chunk);
    if (error) throw new Error(`Could not read rep names: ${error.message}`);
    for (const row of data ?? []) {
      employeeByHrId.set(row.hr_id as string, {
        name: (row.full_name as string) ?? "",
        status: (row.employment_status as string | null) ?? null,
      });
    }
  }

  const missingReps = missingBeforeNames
    // A LEAVER IS NOT A DEFAULTER. The mirror is a scrape of the CRM's live contact grid, and the CRM
    // admin deactivates a resigned rep's account rather than deleting it — so a rep who left mid-month
    // can sit in the mirror with no plan for the period through no fault of anyone. Naming him on a
    // screen headed "Filed nothing" is an accusation the data does not support. `isTerminal` treats an
    // unknown or missing status as NOT terminal, so an unresolvable CRM account is still shown and
    // labelled, exactly as the plans table shows one rather than hiding it.
    // Measured 2026-08-29: all 68 agents in the mirror resolve to an active employee, so this filter
    // removes nobody today. It exists for the month one of them resigns.
    .filter((rep) => !isTerminalEmploymentStatus(rep.hrId ? employeeByHrId.get(rep.hrId)?.status : null))
    .map((rep) => ({
      ...rep,
      name:
        (rep.hrId ? employeeByHrId.get(rep.hrId)?.name : "") || `CRM account ${rep.agentCrmId} — not on the roster`,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { ...base, missingReps, plans, rosterKnown: roster.length > 0, selected };
}

/** Re-exported so a caller holding a scope and an agent can ask the one question without importing
 * two modules. The answer lives in the access module; this is only a convenience. */
export { scopeAllowsAgent };
