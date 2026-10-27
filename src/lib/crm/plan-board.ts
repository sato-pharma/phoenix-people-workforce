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

import { CRM_PLAN_ENTRIES_TABLE, CRM_PLAN_ENTRIES_UNIFIED_VIEW } from "@/lib/crm/tables";
import { IREPORTS360_VISIT_SOURCE } from "@/lib/crm/phoenix-team-starts";
import { getAgentContactList, getDoctorListRepSummaries } from "@/lib/crm/contact-lists";
import { dayScanSlices, readCompanyWindow } from "@/lib/crm/reads";
import { planEntryKeysetAfter } from "@/lib/crm/plan-entry-keyset";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { quotedOrClause } from "@/lib/supabase/search-filter";
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
    (message.includes(CRM_PLAN_ENTRIES_TABLE) || message.includes(CRM_PLAN_ENTRIES_UNIFIED_VIEW)) &&
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
  input: { kind: PlanKind; keepMonth?: { month: number; year: number }; keepRange?: { end: string; start: string } },
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
    // The plan's STATUS is the status of its most-recently-synced row, NOT its first row. A weekly
    // plan straddles a month end, and plan-sync only re-reads the CURRENT month — so a plan for the
    // week of 29 Aug–4 Sep keeps its Aug rows frozen at "Pending" (last synced 31 Aug) while its Sep
    // rows are re-read as "Verified" (synced 21 Sep). Taking the first row's status showed such plans
    // as Pending and counted them in "Awaiting you" although the CRM had signed them off weeks ago
    // (audit, 2026-09-21). The latest sync stamp is the CRM's latest word on the plan, and its status
    // is the one to trust. Tracked together so the two never disagree, and so "last refreshed" stays
    // honest for the whole plan.
    if (row.synced_at && (!plan.syncedAt || row.synced_at > plan.syncedAt)) {
      plan.syncedAt = row.synced_at;
      plan.status = row.plan_status;
    }
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
    if (input.keepRange && summary.firstDate) {
      // The SAME straddle rule, one week wide: a plan belongs to the week it STARTS in. Measured on
      // production 2026-09-01 across all 2,391 weekly plans, none crosses a Saturday, so this drops
      // nothing today — it is what keeps the week tab correct on the day one does.
      if (summary.firstDate < input.keepRange.start || summary.firstDate > input.keepRange.end) continue;
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

/**
 * The same columns plus the entry id, for every paged read below. With the day and the hr id it is the
 * keyset cursor (`plan-entry-keyset.ts`; the id alone is not unique in the view) — it is NOT read by
 * `summarisePlans`, which groups on `crm_plan_id`.
 */
const SCAN_COLUMNS = `${SUMMARY_COLUMNS}, crm_plan_entry_id`;

/** A scanned row carries the cursor column; everything downstream still sees a {@link RawPlanRow}. */
type ScannedPlanRow = RawPlanRow & { crm_plan_entry_id: number | string | null };

/**
 * The window of plan rows a fetch asks for.
 *
 * A monthly plan carries a month and a year and no dates at all, so it can only be selected by
 * those columns. A weekly plan carries dates and no month, so it can only be selected by a date
 * range — which is also what lets the Reps Weekly Plans tab ask for exactly one week instead of a
 * whole month it would then throw most of away.
 */
type PlanWindow =
  | { end: string; kind: "dates"; start: string }
  | { kind: "month"; month: number; year: number };

/**
 * Reads every summary-shaped row in one window, paged. Scope is applied IN SQL, not afterwards.
 *
 * The two callers differ only in the window, so the chunking, the paging and the missing-schema
 * posture live here once. Getting any of those three subtly different between the month board and
 * the week tab is precisely how two screens start disagreeing about whether a rep filed.
 */
async function fetchPlanRows(input: {
  kind: PlanKind;
  scope: PlanVerificationScope;
  window: PlanWindow;
}): Promise<RawPlanRow[]> {
  const supabase = getSupabaseAdmin();

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

  // ── The company-wide date window reads one DAY at a time, with a keyset cursor ──────────────
  //
  // An OFFSET page over a whole month cannot stop early. Postgres has to produce every row in the
  // window and SORT them all to hand back one thousand, then the next page does the identical work
  // and throws a thousand more away — so 26 pages cost 26 full scans of the month to deliver it
  // once. The view makes that worse than it sounds: it is a UNION ALL with two anti-joins, so each
  // page re-materialises both branches. Measured on production 2026-10-10, September `weekly`:
  // 25,862 rows, `limit 1000 offset 24000` = 6,291 buffers and a 17,990 kB quicksort of 25,000 rows
  // for 1,000 of them, 240.9 ms — and the live mean of this exact statement was 791.7 ms across 192
  // calls, about half of ALL database time left after the roster index landed that morning.
  //
  // `crm_plan_entry_id` cannot be indexed for the sort: the view SYNTHESISES it for its Phoenix
  // branch. So the window is split into days instead, each read by cursor, which is the posture the
  // visits and check-in doors already use (`readCompanyWindow` in reads.ts) and which the plan SCAN
  // in rep-doctor-lists.ts took for this same fault on 2026-10-01. The probe keeps a small window
  // (the Reps Weekly Plans tab asks for about seventy plans) at exactly one request.
  //
  // The days are disjoint and cover `[start, end]` exactly, and a null `plan_date` is excluded by
  // `.eq("plan_date", day)` precisely as it was by the `gte`/`lte` pair, so the union is the same
  // rows. Re-sorted by the entry id they are also in the same ORDER as the single scan — though
  // `summarisePlans` is order-independent by construction: it mins/maxes the dates, counts entries,
  // sets the contacts and takes the status of the latest `synced_at`.
  //
  // A window that NAMES agents is not sliced: `agent_hr_id IN (…)` already makes it narrow. Nor is the
  // `month` window — a monthly plan has no `plan_date` at all to slice on. Both walk a keyset below.
  const days =
    input.window.kind === "dates" && chunks.length === 1 && chunks[0] === null
      ? dayScanSlices(input.window.start, input.window.end)
      : null;
  if (days && input.window.kind === "dates") {
    const dateWindow = input.window;
    const scanned = await readCompanyWindow<ScannedPlanRow>({
      days,
      pageSize: PAGE_SIZE,
      probe: async () => {
        const { data, error } = await supabase
          .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
          .select(SCAN_COLUMNS)
          .eq("plan_kind", input.kind)
          .gte("plan_date", dateWindow.start)
          .lte("plan_date", dateWindow.end)
          .limit(PAGE_SIZE);
        if (error) {
          if (isPlanSchemaMissing(error)) return null;
          throw new Error(error.message);
        }
        return (data ?? []) as unknown as ScannedPlanRow[];
      },
      scanDay: async (day) => {
        const scanned: ScannedPlanRow[] = [];
        let cursor: ScannedPlanRow | null = null;
        for (;;) {
          let query = supabase
            .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
            .select(SCAN_COLUMNS)
            .eq("plan_kind", input.kind)
            .eq("plan_date", day);
          if (cursor !== null) query = query.or(planEntryKeysetAfter(cursor, { byDate: false }));
          const { data, error } = await query
            .order("crm_plan_entry_id", { ascending: true })
            .order("agent_hr_id", { ascending: true, nullsFirst: false })
            .limit(PAGE_SIZE);
          if (error) {
            if (isPlanSchemaMissing(error)) return null;
            throw new Error(error.message);
          }
          const page = (data ?? []) as unknown as ScannedPlanRow[];
          scanned.push(...page);
          const last = page[page.length - 1] ?? null;
          if (page.length < PAGE_SIZE || last?.crm_plan_entry_id == null) return scanned;
          cursor = last;
        }
      },
      order: (left, right) => Number(left.crm_plan_entry_id) - Number(right.crm_plan_entry_id),
      sortDays: true,
    });
    // `null` is the missing-plan-mirror answer, which this board degrades to an empty one.
    return scanned ?? [];
  }

  // Every other read walks a keyset, never an OFFSET page (Stage 2a, 28 Oct 2026): each page starts
  // where the last ended instead of re-building and re-sorting the whole window, and a cursor on the
  // whole key cannot step over or repeat a row whose entry id another rep shares. A date window walks
  // (day, entry id, hr id), its `plan_date >= <last day>` landing on the view's grouped day; the month
  // window has no day, and walks (entry id, hr id). Each chunk is handed back in ascending entry id,
  // as the OFFSET scan handed it over.
  const byEntryId = (left: ScannedPlanRow, right: ScannedPlanRow) =>
    Number(left.crm_plan_entry_id) - Number(right.crm_plan_entry_id);
  const rows: RawPlanRow[] = [];
  for (const chunk of chunks) {
    const chunkRows: ScannedPlanRow[] = [];
    let cursor: ScannedPlanRow | null = null;
    for (;;) {
      // The unified view: vendor plans before the CRM cutover date, plans filed in Phoenix from it
      // (negative crm_plan_id, so they never meet a vendor id). Verification itself stays on the
      // vendor table below — it writes back into iReports360.
      let query = supabase.from(CRM_PLAN_ENTRIES_UNIFIED_VIEW).select(SCAN_COLUMNS).eq("plan_kind", input.kind);
      if (input.window.kind === "dates") {
        query = query.gte("plan_date", cursor?.plan_date ?? input.window.start).lte("plan_date", input.window.end);
        if (cursor !== null) query = query.or(planEntryKeysetAfter(cursor, { byDate: true }));
        query = query.order("plan_date", { ascending: true });
      } else {
        query = query.eq("plan_month", input.window.month).eq("plan_year", input.window.year);
        if (cursor !== null) query = query.or(planEntryKeysetAfter(cursor, { byDate: false }));
      }
      if (chunk) query = query.in("agent_hr_id", [...chunk]);
      const { data, error } = await query
        .order("crm_plan_entry_id", { ascending: true })
        .order("agent_hr_id", { ascending: true, nullsFirst: false })
        .limit(PAGE_SIZE);
      if (error) {
        if (isPlanSchemaMissing(error)) return [];
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as ScannedPlanRow[];
      chunkRows.push(...page);
      const last = page[page.length - 1] ?? null;
      if (page.length < PAGE_SIZE || last?.crm_plan_entry_id == null) break;
      if (input.window.kind === "dates" && !last.plan_date) break;
      cursor = last;
    }
    rows.push(...chunkRows.sort(byEntryId));
  }
  return rows;
}

/** Reads every summary-shaped row for one MONTH, paged. The month board's window. */
async function fetchSummaryRows(input: {
  kind: PlanKind;
  month: number;
  year: number;
  scope: PlanVerificationScope;
}): Promise<RawPlanRow[]> {
  const bounds = monthBounds(input.month, input.year);
  return fetchPlanRows({
    kind: input.kind,
    scope: input.scope,
    window:
      input.kind === "weekly"
        ? // Wider than the month on purpose — see PLAN_STRADDLE_MARGIN_DAYS. `summarisePlans` throws
          // away anything that does not START inside the month.
          {
            end: addDays(bounds.end, PLAN_STRADDLE_MARGIN_DAYS),
            kind: "dates",
            start: addDays(bounds.start, -PLAN_STRADDLE_MARGIN_DAYS),
          }
        : { kind: "month", month: input.month, year: input.year },
  });
}

/**
 * Every weekly plan in the viewer's reach that STARTS inside one field week.
 *
 * The Reps Weekly Plans tab's read. It deliberately does NOT narrow to the selected rep in SQL:
 * the only column that could do that is `agent_hr_id`, and hr ids are mixed case in this database,
 * so an `.in()` on them under-returns silently — and under-returning here would tell a district
 * manager his rep filed nothing. The caller matches on the NUMERIC agent id instead, the same rule
 * `repsWithNoPlan` states and for the same reason. A week is small enough that this costs nothing:
 * measured on production 2026-09-01, the mirror holds about seventy weekly plans per week
 * company-wide.
 *
 * Rep NAMES are not resolved here. The tab already knows the rep — it picked him from the org tree
 * — and `PlanSummary.repName` is left empty for the caller to fill from that same tree, which is
 * the one source both tabs share.
 */
export async function getWeeklyPlansForWeek(input: {
  scope: PlanVerificationScope;
  weekEnd: string;
  weekStart: string;
}): Promise<PlanSummary[]> {
  if (input.scope.kind === "none") return [];
  const rows = await fetchPlanRows({
    kind: "weekly",
    scope: input.scope,
    // The margin is the same belt-and-braces the month window uses: fetch wider, then keep only
    // plans that START in the week. No plan in production crosses a Saturday, so the margin costs
    // a few rows and buys correctness if one ever does.
    window: {
      end: addDays(input.weekEnd, PLAN_STRADDLE_MARGIN_DAYS),
      kind: "dates",
      start: addDays(input.weekStart, -PLAN_STRADDLE_MARGIN_DAYS),
    },
  });
  return summarisePlans(rows, { keepRange: { end: input.weekEnd, start: input.weekStart }, kind: "weekly" });
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
      .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
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

/** One agent's plan rows over a date window, for the Phoenix CRM "Copy last month" reference. */
export type AgentPlanEntryRow = {
  contact_crm_id: number | null;
  ampm: string | null;
  contact_grade: string | null;
  contact_name: string | null;
  speciality: string | null;
  plan_date: string | null;
  plan_frequency: number | null;
};

/**
 * Last month's plan rows for one agent, by hr id, over a date window — the source of the native CRM's
 * "Copy last month". This lives here, behind the CRM door, so no module outside src/lib/crm queries the
 * plan mirror directly (tests/crm-single-source.test.ts). A missing plan schema degrades to `null`
 * (no reference), never an error, exactly as the other iReports360 readers here do.
 *
 * `ilike` with no wildcard is a case-insensitive exact match — the mixed-case agent_hr_id makes a plain
 * .eq under-return. Weekly rows carry a plan_date; monthly rows carry a frequency and no date, so both
 * are asked for (dated in the window, or the month/year) and the caller splits them out.
 */
export async function getAgentPlanEntriesForWindow(
  agentHrId: string,
  start: string,
  end: string,
): Promise<AgentPlanEntryRow[] | null> {
  const supabase = getSupabaseAdmin();
  const rows: AgentPlanEntryRow[] = [];
  // 🔴 KEYSET-PAGED ON THE MIRROR'S OWN KEY, never by offset (2026-10-16 speed audit). An offset page
  // with no order is not a stable slice — a row can land on two pages or on none — and each later page
  // re-reads every row before it. `crm_plan_entry_id` is unique within the iReports360 source this read
  // is narrowed to, and the day-sliced scan above pages on it the same way.
  let cursor: number | string | null = null;
  for (;;) {
    let query = supabase
      .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
      .select("crm_plan_entry_id, contact_crm_id, ampm, contact_grade, contact_name, speciality, plan_date, plan_frequency")
      // The rep's iReports360 plan only — "Copy last month" replays the vendor's reference plan; since
      // 2026-10-02 the view also carries a started team's own Phoenix plans (crm/phoenix-team-starts.ts).
      .eq("source", IREPORTS360_VISIT_SOURCE)
      .ilike("agent_hr_id", agentHrId)
      .or(`and(plan_date.gte.${start},plan_date.lte.${end}),and(plan_month.eq.${Number(start.slice(5, 7))},plan_year.eq.${Number(start.slice(0, 4))})`);
    if (cursor !== null) query = query.gt("crm_plan_entry_id", cursor);
    const { data, error } = await query.order("crm_plan_entry_id", { ascending: true }).limit(PAGE_SIZE);
    if (error) {
      if (isPlanSchemaMissing(error)) return null;
      throw new Error(error.message);
    }
    // The key rides along as the cursor; the one caller (plan-history.ts) reads the named fields only.
    const page = (data ?? []) as unknown as Array<AgentPlanEntryRow & { crm_plan_entry_id: number | string | null }>;
    rows.push(...page);
    const last = page[page.length - 1]?.crm_plan_entry_id ?? null;
    if (page.length < PAGE_SIZE || last === null || last === cursor) break;
    cursor = last;
  }
  return rows;
}

/** One planned call of a rep's iReports360 weekly plan — the day, the contact and the plan's approval status. */
export type AgentWeekPlanEntry = {
  agentHrId: string;
  contactCrmId: number;
  contactGrade: string | null;
  contactName: string | null;
  crmPlanId: number;
  planDate: string;
  speciality: string | null;
  status: number | null;
};

/** `agent_hr_id` goes into a filter string — the value is QUOTED (`quotedOrClause`) instead of being
 * matched against a shape. The old allow-list `/^[A-Za-z0-9-]{1,32}$/` made the filter safe by
 * DROPPING every id it did not recognise, which on this read means the rep's whole week vanishes
 * from his manager's board with no error anywhere; quoting keeps the id and makes its characters
 * literal (AGENTS.md MR-B04). */

/**
 * Several reps' iReports360 weekly plans over one field week — the plan a district manager sees for a
 * rep who is still working in the old CRM (owner, 2026-10-17: "their plans on the CRM must appear to the
 * district manager when he is making his weekly plan in Phoenix").
 *
 * The vendor plan carries a DAY per planned contact and no morning or afternoon (`appm`, `startAM` and
 * `startPM` are empty on every row measured 2026-10-17), so the caller places a contact by the half of the
 * list he sits on.
 *
 * 🔴 READ FROM THE VENDOR'S OWN ROWS, NEVER THE UNIFIED VIEW. `crm_plan_entries_unified` anti-joins every
 * iReports360 plan entry of a rep in a STARTED team from his `counted_from` on (Phoenix counts him
 * instead), and every team is started — so through the view this read answered ZERO for every rep who
 * mattered: on 2026-10-18 the raw mirror held 22 reps' weeks for 17 Oct (59 calls for one Pedia rep alone,
 * synced 14:04 Cairo) and the view held none, so the manager's board read "No plan this week" and greyed
 * every old-CRM rep out. The question here is what a rep filed in the OLD app, which the raw mirror
 * answers and the counting view must not. The raw table carries no Phoenix plans (those live in
 * `phoenix_crm_plans`), so no `source` filter is needed. Plan verification resolves a plan the same way
 * (`getPlanForVerification`). `ilike` with no wildcard is a case-insensitive exact match, for the
 * mixed-case `agent_hr_id`. A missing plan schema degrades to `null`, never an error.
 */
export async function getAgentsWeekPlanEntries(
  agentHrIds: ReadonlyArray<string>,
  start: string,
  end: string,
): Promise<AgentWeekPlanEntry[] | null> {
  const ids = [...new Set(agentHrIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  const supabase = getSupabaseAdmin();
  const found: AgentWeekPlanEntry[] = [];
  for (let from = 0; from < ids.length; from += IN_CHUNK) {
    const part = ids.slice(from, from + IN_CHUNK);
    let cursor: number | string | null = null;
    for (;;) {
      let query = supabase
        .from(CRM_PLAN_ENTRIES_TABLE)
        .select("crm_plan_entry_id, crm_plan_id, agent_hr_id, contact_crm_id, contact_grade, contact_name, speciality, plan_date, plan_status")
        .eq("plan_kind", "weekly")
        .gte("plan_date", start)
        .lte("plan_date", end)
        .or(part.map((id) => quotedOrClause("agent_hr_id", "ilike", id)).join(","));
      if (cursor !== null) query = query.gt("crm_plan_entry_id", cursor);
      const { data, error } = await query.order("crm_plan_entry_id", { ascending: true }).limit(PAGE_SIZE);
      if (error) {
        if (isPlanSchemaMissing(error)) return null;
        throw new Error(error.message);
      }
      const page = (data ?? []) as unknown as Array<{
        crm_plan_entry_id: number | string | null;
        crm_plan_id: number | null;
        agent_hr_id: string | null;
        contact_crm_id: number | string | null;
        contact_grade: string | null;
        contact_name: string | null;
        speciality: string | null;
        plan_date: string | null;
        plan_status: number | null;
      }>;
      for (const row of page) {
        const contactCrmId = row.contact_crm_id == null ? NaN : Number(row.contact_crm_id);
        if (!row.agent_hr_id || !row.plan_date || row.crm_plan_id == null || !Number.isFinite(contactCrmId)) continue;
        found.push({
          agentHrId: row.agent_hr_id,
          contactCrmId,
          contactGrade: row.contact_grade,
          contactName: row.contact_name,
          crmPlanId: row.crm_plan_id,
          planDate: row.plan_date.slice(0, 10),
          speciality: row.speciality,
          status: row.plan_status,
        });
      }
      const last = page[page.length - 1]?.crm_plan_entry_id ?? null;
      if (page.length < PAGE_SIZE || last === null || last === cursor) break;
      cursor = last;
    }
  }
  return found;
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
  // Read the MOST-RECENTLY-SYNCED row, so the status the write is checked against matches the one
  // the board shows. Without an order, `.limit(1)` returned an arbitrary row of the plan's ~100: for
  // a plan straddling a month end (Aug rows frozen Pending, Sep rows Verified — see summarisePlans),
  // the same Verify click randomly got "already verified" or a real re-write (audit, 2026-09-21). The
  // agent, month, year and kind are plan-level constants, so only the status turns on which row wins;
  // the plan_status tiebreak keeps it deterministic when two rows share a sync stamp.
  const { data, error } = await supabase
    .from(CRM_PLAN_ENTRIES_TABLE)
    .select("agent_crm_id, agent_hr_id, plan_kind, plan_month, plan_status, plan_year, synced_at")
    .eq("crm_plan_id", crmPlanId)
    .order("synced_at", { ascending: false, nullsFirst: false })
    .order("plan_status", { ascending: false })
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
