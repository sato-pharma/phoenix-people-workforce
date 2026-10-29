import { getOrLoadShared, sharedReadKey } from "@/lib/cache/shared-read";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { logError } from "@/lib/observability/log";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { CRM_PLAN_ENTRIES_UNIFIED_VIEW } from "@/lib/crm/tables";
import { IREPORTS360_VISIT_SOURCE } from "@/lib/crm/phoenix-team-starts";
import { isMissingCrmRpcError, readContactVisitHistory, type CrmContactVisitHistory } from "@/lib/crm/reads";
import { averageCheckinPoint, type ObservedPoint } from "@/lib/crm/checkin-location";

/** Contact ids per `in(...)` filter, and rows per page — the figures the rest of this module uses. */
const IN_CHUNK = 50;
const PLAN_PAGE = 1000;
/** Chunks read at once — the Reps List's own figure. */
const CHUNK_CONCURRENCY = 4;
/** One pin per doctor; the largest list measured was 197 doctors, so this holds every list many times over. */
const OBSERVED_POINTS_SHARED_LIMITS = { maxEntries: 200, maxRowsTotal: 50_000 };

import { getDoctorListRepSummaries } from "@/lib/crm/contact-lists";
import { findSharedCustomers, type SharedWith } from "@/lib/crm/location-confidence";
import { repDoctorListRepKey } from "@/lib/crm/rep-doctor-lists";
import { loadCheckins, loadContactRoster, loadPinsFor } from "@/lib/crm/reps-list";
import { CRM_OBSERVED_POINTS } from "@/lib/crm/shared-windows";

/**
 * 🔴 WHERE A DOCTOR ACTUALLY IS, from the check-ins already in the mirror (owner, 2026-09-30: "you
 * will get the location of the doctor from the check-ins taken for this doctor and put it in the
 * location here", and "make an average"). The READ is `loadCheckins`, reused exactly as the old
 * board uses it — he asked in the same breath that this not be built twice. The averaging rule is
 * `averageCheckinPoint`, and the reasoning for it lives there.
 *
 * Returns nothing rather than throwing: a customer with no check-ins, a missing mirror or an
 * unreadable view all mean "nobody has stood there", which is an answer, not a failure.
 */
/**
 * 🔴 WHEN EACH DOCTOR IS USUALLY PLANNED, off the iReports360 reference plans (owner, 2026-09-30:
 * "based on the reference weekly plans from iReports360, tell him — you are visiting this doctor
 * Sunday and Tuesday, in the first and the fourth week").
 *
 * The WINDOW is the last four months of plan dates. Long enough that every week of a month has had
 * a chance to appear — a doctor planned in week 4 only shows up once a month — and short enough that
 * a pattern the rep abandoned in the spring is not still being read back to him.
 *
 * Returns the DATES; `planWeekdays` turns them into the pattern, and lives in the pure layer so it
 * can be tested without a database.
 */
export async function loadPlanDatesFor(contactCrmIds: readonly number[], fromIsoDay: string): Promise<Map<number, string[]>> {
  if (contactCrmIds.length === 0) return new Map();
  const ids = [...new Set(contactCrmIds)];
  // 🔴 GATHERED IN THE DATABASE, ONE ROW PER CONTACT (2026-10-16 Phoenix CRM performance audit). The
  // List needs each doctor's plan days and nothing else, and this used to carry every plan row of every
  // doctor to the app — fifty doctors a request, a page of 1,000 at a time by OFFSET over the union
  // view. The function runs the same filter over the same view and hands back the same days, newest
  // first; until it is applied here, the page walk answers exactly as before.
  const counted = await loadPlanDatesCounted(ids, fromIsoDay);
  return counted ?? loadPlanDatesPaged(ids, fromIsoDay);
}

/** Server-side gathering over the plan door's iReports360 rows (…20261016180202). */
const CRM_CONTACT_PLAN_DATES_RPC = "phx_crm_contact_plan_dates";

/**
 * Contacts per call. One row per contact comes back, so 500 stays well under PostgREST's 1,000-row cap
 * and the ids travel in the request body, never the URL.
 */
const PLAN_DATES_RPC_CHUNK = 500;

/** `null` when the function has not reached this database yet — the caller then walks the pages. */
async function loadPlanDatesCounted(ids: readonly number[], fromIsoDay: string): Promise<Map<number, string[]> | null> {
  const supabase = getSupabaseAdmin();
  type PlanDatesRow = { contact_crm_id: number | string | null; plan_dates: string[] | null };
  const chunks = Array.from({ length: Math.ceil(ids.length / PLAN_DATES_RPC_CHUNK) }, (_unused, index) =>
    ids.slice(index * PLAN_DATES_RPC_CHUNK, (index + 1) * PLAN_DATES_RPC_CHUNK),
  );
  const answers = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, async (chunk) => {
    const { data, error } = await supabase.rpc(CRM_CONTACT_PLAN_DATES_RPC, { p_contact_crm_ids: chunk, p_from: fromIsoDay });
    return { error: error as unknown, rows: (data ?? []) as PlanDatesRow[] };
  });
  const byContact = new Map<number, string[]>();
  for (const { error, rows } of answers) {
    if (error && isMissingCrmRpcError(error)) return null;
    for (const row of rows) {
      if (row.contact_crm_id == null || !Array.isArray(row.plan_dates) || row.plan_dates.length === 0) continue;
      byContact.set(Number(row.contact_crm_id), row.plan_dates);
    }
    if (error) {
      // A missing or unreadable plan mirror costs this one column and nothing else — as it always did.
      logError("Phoenix CRM list: the reference plan dates could not be read", {
        error,
        labels: { event: "phoenix_crm_plan_pattern_failed" },
      });
      return byContact;
    }
  }
  return byContact;
}

/** The page walk the gathering replaced — kept for a database the function has not reached yet. */
async function loadPlanDatesPaged(ids: readonly number[], fromIsoDay: string): Promise<Map<number, string[]>> {
  const supabase = getSupabaseAdmin();
  const byContact = new Map<number, string[]>();
  type PlanDateRow = { contact_crm_id: number | null; plan_date: string | null };
  // One chunk's pages, in order; a failed page hands back the pages before it WITH its error.
  const readChunk = async (chunk: number[]): Promise<{ error: unknown; rows: PlanDateRow[] }> => {
    const rows: PlanDateRow[] = [];
    for (let page = 0; ; page += 1) {
      const { data, error } = await supabase
        .from(CRM_PLAN_ENTRIES_UNIFIED_VIEW)
        .select("contact_crm_id, plan_date")
        // The iReports360 REFERENCE plans only: since 2026-10-02 the view also carries a started team's
        // own Phoenix plans (crm/phoenix-team-starts.ts), and those are his, already on his screen.
        .eq("source", IREPORTS360_VISIT_SOURCE)
        .in("contact_crm_id", chunk)
        .not("plan_date", "is", null)
        .gte("plan_date", fromIsoDay)
        .order("plan_date", { ascending: false })
        .range(page * PLAN_PAGE, page * PLAN_PAGE + PLAN_PAGE - 1);
      if (error) return { error, rows };
      const pageRows = (data ?? []) as PlanDateRow[];
      rows.push(...pageRows);
      if (pageRows.length < PLAN_PAGE) return { error: null, rows };
    }
  };
  // 🔴 A FEW CHUNKS AT ONCE, FOLDED IN CHUNK ORDER (2026-10-01, "slow to transfer between page and
  // page", Phoenix CRM first). One after another, a rep's list paid one round trip per fifty doctors
  // before the List could paint; folded in order once they are in, the answer is the one the serial
  // loop gave — the same dates, and the same first failure ending the read where it ended before.
  const chunks = Array.from({ length: Math.ceil(ids.length / IN_CHUNK) }, (_unused, index) => ids.slice(index * IN_CHUNK, (index + 1) * IN_CHUNK));
  const answers = await mapWithConcurrency(chunks, CHUNK_CONCURRENCY, readChunk);
  for (const { error, rows } of answers) {
    for (const row of rows) {
      if (row.contact_crm_id == null || !row.plan_date) continue;
      const found = byContact.get(row.contact_crm_id);
      if (found) found.push(row.plan_date);
      else byContact.set(row.contact_crm_id, [row.plan_date]);
    }
    if (error) {
      // A missing or unreadable plan mirror costs this one column and nothing else.
      logError("Phoenix CRM list: the reference plan dates could not be read", {
        error,
        labels: { event: "phoenix_crm_plan_pattern_failed" },
      });
      return byContact;
    }
  }
  return byContact;
}

/**
 * What the rep has already done with a doctor, straight from the read door.
 *
 * 🔴 The QUERY lives in reads.ts, not here (owner's rule that work is not built twice, and the
 * single-source guard's rule that the visits mirror is read through one door). This is the thin
 * re-export Phoenix CRM's List calls, so the List never reaches the visits mirror itself — and its
 * planner too, which asks the same read for the days of the last weeks (`daysSince`) to learn when a
 * customer not validated yet is usually seen (owner, 2026-10-02).
 */
export type VisitHistory = CrmContactVisitHistory;

export async function loadVisitHistoryFor(contactCrmIds: readonly number[], options: { daysSince?: string } = {}): Promise<Map<number, VisitHistory>> {
  return readContactVisitHistory(contactCrmIds, options);
}

type ObservedPointRow = ObservedPoint & { contactCrmId: number };

/**
 * Where reps have actually stood at each of these doctors — the averaged iReports360 check-in, for the
 * List's address, map link and board colour. A LOCATION for display, never a judgement (rowPoint,
 * list-row-facts.ts): nothing approves, pays or notifies from it.
 *
 * SHARED FOR A MINUTE (28 Oct 2026 production read audit). Every List open re-read every check-in of
 * the same doctors, cold — 8,527 reads of one shape in three days, 234,221 of them disk reads, on a
 * table that keeps falling out of memory — to make one small pin per doctor. Only that derived pin is
 * kept, keyed by the exact doctors asked about, so a caller only ever receives the doctors its own
 * scoped list named; at most `SHARED_READ_TTL_MS` old, the window the owner chose for display reads on
 * 2026-10-16, and dropped at once by `refreshSharedCrmWindows` when a poll writes check-ins. The pins
 * are kept as an array — a Map does not survive the copy — and a failed read throws and is never kept.
 */
export async function loadObservedPointsFor(contactCrmIds: readonly number[]): Promise<Map<number, ObservedPoint>> {
  const ids = [...new Set(contactCrmIds)];
  if (ids.length === 0) return new Map();
  const key = sharedReadKey({ ids: [...ids].sort((left, right) => left - right) });
  const { rows } = await getOrLoadShared(CRM_OBSERVED_POINTS, key, () => readObservedPoints(ids), OBSERVED_POINTS_SHARED_LIMITS);
  const observed = new Map<number, ObservedPoint>();
  for (const { contactCrmId, ...point } of rows ?? []) observed.set(contactCrmId, point);
  return observed;
}

/** The live read behind `loadObservedPointsFor`: the doctors' check-ins, averaged to one pin each. */
async function readObservedPoints(contactCrmIds: readonly number[]): Promise<ObservedPointRow[]> {
  const checkins = await loadCheckins(contactCrmIds);
  const observed: ObservedPointRow[] = [];
  for (const [contactCrmId, found] of checkins) {
    const point = averageCheckinPoint(found.points);
    if (point) observed.push({ ...point, address: found.seenAt.address, contactCrmId });
  }
  return observed;
}

/**
 * Which of a rep's customers ANOTHER rep also carries — the old Reps List's violet highlight, made
 * reusable so Phoenix CRM's List can show the same thing.
 *
 * 🔴 THE OWNER, 2026-09-30, listing what the old board did that the new one did not: "if a doctor is
 * shared between this rep and another rep, it was highlighted." The matcher itself is not new — it
 * is `findSharedCustomers`, unchanged — but it lived inside `getRepsListForAgent`, which reads the
 * whole iReports360 board for one rep. Phoenix CRM's List needs the answer and none of the rest, so
 * the narrow half is lifted here and both boards now call the same code.
 *
 * WHY IT IS AN INFERENCE, AND WHY THAT IS SAID ON SCREEN. iReports360 gives every rep their own row
 * for one doctor, so nothing in the data states that two rows are one person: it is worked out from
 * the name and the pin, or from a shared phone. `describeSharing` prints the basis beside the
 * highlight precisely so a reader who disagrees can overrule it. This module never merges anything
 * and never reassigns anyone — the owner's standing rule is that a two-line customer is a treasure,
 * not a duplicate to be tidied away.
 *
 * COST. One roster read (the open assignments, a few narrow columns), then pins for ONLY the
 * contacts that could possibly be the same customer — the candidate set is filtered on the name and
 * phone keys of the rep's own rows before a single pin is fetched. That is the same shape the board
 * has always paid, and a rep's own List is a page one person opens.
 */

/**
 * A partner we cannot name is never shown — the board's own rule, kept.
 *
 * Takes the rep's HR ID rather than a rep key, because the caller is Phoenix CRM's own territory
 * loader and it knows the seat's occupant, not his iReports360 account. The key is resolved here from
 * the same summaries the names come from: the CRM id when the rep has one, `hr:<id>` when he does
 * not — keyed on the CRM id alone, a rep hired without an account is a stranger to his own rows.
 */
export async function loadSharedCustomersFor(
  contactCrmIds: readonly number[],
  repHrId: string,
): Promise<Map<number, SharedWith[]>> {
  if (contactCrmIds.length === 0) return new Map();

  // The summaries FIRST, and the roster only once they say a match is possible. They are the cached
  // read (five minutes, tag-busted), so asking for them alone costs nothing; the roster is the
  // expensive one — a count, then every open assignment in pages with the contact embedded.
  const summaries = await getDoctorListRepSummaries();

  // 🔴 THE REP NAMES ARE REQUIRED, NOT OPTIONAL. `findSharedCustomers` never names — and so never
  // matches — a partner whose key it cannot resolve. Handing it an empty map finds nothing at all,
  // which reads exactly like a company with no shared customers rather than like a caller that
  // forgot.
  const repNames = new Map<string, string>();
  let repKey: string | null = null;
  for (const summary of summaries) {
    const key = repDoctorListRepKey(summary.agentCrmId, summary.hrId);
    if (!key) continue;
    const name = summary.name?.trim();
    if (name) repNames.set(key, name);
    if (summary.hrId === repHrId) repKey = key;
  }
  // 🔴 NO NAME, NO MATCH — SO NO ROSTER (2026-10-01, "slow to transfer between page and page",
  // Phoenix CRM first). With no partner that can be named, `findSharedCustomers` can only answer an
  // empty map, which is exactly what this returns — and until now the whole company-wide roster was
  // read first to arrive at it: the 420 ms-mean `crm_contact_assignments` read in production.
  // ⚠ Today EVERY summary is built with `name: ""` (`summarizeRepLists`), so this returns here on
  // every call and the List's "shared with" highlight never shows; once the summaries carry names
  // again it stops short-circuiting on its own, and the roster is read as before.
  if (repNames.size === 0) return new Map();
  // A rep with no iReports360 account at all still has a key of his own.
  repKey ??= repDoctorListRepKey(null, repHrId);
  if (!repKey) return new Map();

  const roster = await loadContactRoster();
  if (roster.length === 0) return new Map();

  // Narrow the roster to the contacts that could possibly be the same customer BEFORE asking for any
  // pins. The matching keys come from the roster on BOTH sides, so the two halves of a pair are
  // normalized identically — reading one side off a display row would compare a real name against
  // the "Contact 12345" placeholder a nameless row falls back to.
  const rosterById = new Map(roster.map((entry) => [entry.contactCrmId, entry]));
  const mineNameKeys = new Set<string>();
  const minePhoneKeys = new Set<string>();
  for (const id of contactCrmIds) {
    const entry = rosterById.get(id);
    if (!entry) continue;
    if (entry.nameKey) mineNameKeys.add(entry.nameKey);
    if (entry.phoneKey) minePhoneKeys.add(entry.phoneKey);
  }
  if (mineNameKeys.size === 0 && minePhoneKeys.size === 0) return new Map();

  const mineIds = new Set(contactCrmIds);
  const candidateIds = roster
    .filter(
      (entry) =>
        entry.repKey !== repKey &&
        !mineIds.has(entry.contactCrmId) &&
        ((entry.nameKey !== "" && mineNameKeys.has(entry.nameKey)) || (entry.phoneKey != null && minePhoneKeys.has(entry.phoneKey))),
    )
    .map((entry) => entry.contactCrmId);
  if (candidateIds.length === 0) return new Map();

  const pins = await loadPinsFor([...mineIds, ...candidateIds]);

  return findSharedCustomers(
    contactCrmIds.map((contactCrmId) => ({ contactCrmId, repKey })),
    roster,
    pins,
    repNames,
  );
}
