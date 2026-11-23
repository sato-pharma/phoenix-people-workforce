/**
 * What Expense Approvals loads: the claims that WAIT, sorted into lanes, and five true tiles.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). The page it replaces read every trip ever
 * filed — 694 rows with `select("*")`, route polylines included — to draw a list of the 64 that
 * waited, then asked four more requests per trip in the reviewer. This reads:
 *
 *   1. the waiting claims, on the columns the row draws (`DESK_CLAIM_COLUMNS`);
 *   2. the decided claims on a slim set, for the tiles, the duplicate check and the meter;
 *   3. the payroll rows that carry accepted claims, for where each one stands;
 *   4. Phoenix CRM, once, for every waiting trip (`field-evidence.ts`).
 *
 * History is not read here at all: it loads 50 at a time on a press (`history.ts`).
 *
 * 🔴 SCOPE IS APPLIED TWICE, as on every expense read: the query is filtered to the viewer's
 *    allowed HR ids, and the rows it returned are narrowed again in memory
 *    (`keepExpenseRowsInScope`), so a filter that normalises to nothing fails closed.
 *
 * Read-only. Nothing here moves money, and no total is derived twice: a waiting claim's figures
 * come from the one payroll mapper, a decided claim's from its stored payroll row.
 */

import type { AccessContext } from "@/lib/auth/permissions";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { summarizeAgreement } from "@/lib/outstation/approvals/agreement";
import { isTripClaim, shortDay } from "@/lib/outstation/approvals/checks";
import {
  buildDeskClaim,
  claimInWords,
  DECIDED_CLAIM_COLUMNS,
  DESK_CLAIM_COLUMNS,
  destinationOfRow,
  LEDGER_COLUMNS,
  odometerReadingsOfRow,
  oneWayKmOfRow,
  receiptPrintsOfRow,
  requestIdOfRow,
  tripDatesOfRow,
  type ClaimRow,
  type LedgerRow,
  type OdometerChain,
} from "@/lib/outstation/approvals/claim-row";
import { loadFieldEvidence, pointOf, type FieldEvidence, type FieldEvidenceTrip } from "@/lib/outstation/approvals/field-evidence";
import { countTripStandings, newestPayout, readTripStanding, type PayoutPeriod, type TripStanding } from "@/lib/outstation/approvals/standing";
import type { DeskClaim, DeskQueue } from "@/lib/outstation/approvals/types";
import { flagDuplicateTicketRows } from "@/lib/outstation/duplicate-ticket-guard";
import { flagDuplicateTripRows } from "@/lib/outstation/duplicate-trip-guard";
import { withLiveOutstationEmployeeNames } from "@/lib/outstation/employee-name";
import { applyEmployeeHrIdInFilter, keepExpenseRowsInScope, resolveExpenseAccessFilter } from "@/lib/outstation/expenses";
import { fetchAllRows } from "@/lib/outstation/page-all-rows";
import { payableExpenseAmount } from "@/lib/outstation/payable";
import { outstationPayrollTripId } from "@/lib/outstation/payroll-expense-mapping";
import { OUTSTATION_UNDECIDED_STATUSES } from "@/lib/outstation/undecided-claim";
import { rowSecurityClientFor } from "@/lib/supabase/rls-server";

const REQUESTS = "outstation_expense_requests";
const UNDECIDED_LIST = `(${OUTSTATION_UNDECIDED_STATUSES.join(",")})`;

const text = (value: unknown): string => String(value ?? "").trim();
const num = (value: unknown): number | null => {
  const out = value === null || value === undefined || value === "" ? Number.NaN : Number(value);
  return Number.isFinite(out) ? out : null;
};

export type AccessFilter = Awaited<ReturnType<typeof resolveExpenseAccessFilter>>;
export type DeskClient = Awaited<ReturnType<typeof rowSecurityClientFor>>;

export async function readClaimRows(
  supabase: DeskClient,
  accessFilter: AccessFilter,
  columns: string,
  narrow: "waiting" | "decided" | { ids: number[] },
): Promise<ClaimRow[]> {
  const allowed = Array.from(accessFilter.allowedHrIds);
  if (!accessFilter.all && allowed.length === 0) return [];
  if (typeof narrow === "object" && narrow.ids.length === 0) return [];
  const build = () => {
    let query = supabase.from(REQUESTS).select(columns).order("created_at", { ascending: true }).order("id", { ascending: true });
    if (narrow === "waiting") query = query.in("status", [...OUTSTATION_UNDECIDED_STATUSES]);
    else if (narrow === "decided") query = query.not("status", "in", UNDECIDED_LIST);
    else query = query.in("id", narrow.ids);
    return accessFilter.all ? query : applyEmployeeHrIdInFilter(query, allowed);
  };
  const { data, error } = await fetchAllRows((from, to) => build().range(from, to));
  if (error) throw error;
  return keepExpenseRowsInScope((data ?? []) as unknown as ClaimRow[], accessFilter, "employee_hr_id");
}

/** The payroll rows that carry app claims, by trip id. `tripIds` narrows it to a few claims. */
export async function readLedger(supabase: DeskClient, tripIds?: string[]): Promise<Map<string, LedgerRow>> {
  if (tripIds && tripIds.length === 0) return new Map();
  const build = () => {
    const query = supabase.from("outstation_expenses").select(LEDGER_COLUMNS).order("trip_id", { ascending: true });
    return tripIds ? query.in("trip_id", tripIds) : query.like("trip_id", "OUTSTATION-%");
  };
  const { data, error } = await fetchAllRows((from, to) => build().range(from, to));
  if (error) throw error;
  return new Map(((data ?? []) as unknown as LedgerRow[]).map((row) => [String(row.trip_id), row]));
}

/**
 * The newest payout month a payroll has paid: the newest one any payroll row carries a paid stamp
 * for, sheet trips included. One row is read. An approved trip of that month or an earlier one that
 * is not marked paid was missed by its own payroll (standing.ts, `approved_missed`).
 * A failed read THROWS, like every other read here: guessing would call a missed trip "next payroll".
 */
export async function readLastPaidPayout(supabase: DeskClient): Promise<PayoutPeriod | null> {
  const { data, error } = await supabase
    .from("outstation_expenses")
    .select("payout_month, payout_year")
    .or("imported_payroll_batch_id.not.is.null,imported_to_payroll_at.not.is.null")
    .order("payout_year", { ascending: false, nullsFirst: false })
    .order("payout_month", { ascending: false, nullsFirst: false })
    .limit(1);
  if (error) throw error;
  return newestPayout((data ?? []) as unknown as Array<{ payout_month?: unknown; payout_year?: unknown }>);
}

export function standingOfRow(row: ClaimRow, ledger: LedgerRow | null, lastPaidPayout: PayoutPeriod | null = null): TripStanding {
  return readTripStanding({
    hasPayrollRow: ledger !== null,
    lastPaidPayout,
    payoutMonth: ledger?.payout_month ?? null,
    payoutYear: ledger?.payout_year ?? null,
    payrollStamped: Boolean(ledger?.imported_payroll_batch_id || ledger?.imported_to_payroll_at),
    status: text(row.status),
  }).standing;
}

export type DuplicateFinding = {
  /** Other trips of this employee that share a day with this one, not already named as a copy. */
  days: string[];
  related: number[];
  tickets: string[];
  trips: string[];
};

/** A claim that pays nothing: a rejected, withdrawn, cancelled or draft one is no copy and no reading. */
const NOT_CLAIMING = /reject|declin|cancel|withdraw|draft/i;

const person = (row: ClaimRow) => text(row.employee_hr_id).toLowerCase();

function daysInWords(days: ReadonlyArray<string>): string {
  const labels = days.map(shortDay);
  return labels.length <= 1 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * The duplicate check's findings for each claim in `subjects`, named in words. `others` are the
 * same people's other claims; a rejected one is no copy (the guards skip it). Pure — the two existing guards
 * decide what a duplicate is, this only words it.
 */
export function findDuplicates(subjects: ReadonlyArray<ClaimRow>, others: ReadonlyArray<ClaimRow>): Map<number, DuplicateFinding> {
  const subjectIds = new Set(subjects.map(requestIdOfRow));
  const people = new Set(subjects.map(person).filter(Boolean));
  const rows = [...subjects, ...others.filter((row) => people.has(person(row)))];
  const byId = new Map(rows.map((row) => [String(requestIdOfRow(row)), row]));
  const dated = rows.filter((row) => tripDatesOfRow(row).length > 0);

  const trips = flagDuplicateTripRows(
    dated.map((row) => ({
      capturedLatitude: num(row.captured_latitude),
      capturedLongitude: num(row.captured_longitude),
      date: tripDatesOfRow(row)[0],
      hrId: text(row.employee_hr_id),
      location: destinationOfRow(row),
      status: text(row.status),
      to: destinationOfRow(row),
      tripId: String(requestIdOfRow(row)),
      tripType: text(row.expense_type),
    })),
  );
  const tickets = flagDuplicateTicketRows(
    dated.map((row) => {
      const dates = tripDatesOfRow(row);
      return {
        date: dates[0],
        goTicketAmount: num(row.go_ticket_amount),
        hrId: text(row.employee_hr_id),
        otherAmount: num(row.report_other_amount) ?? num(row.other_amount),
        receipts: receiptPrintsOfRow(row),
        returnTicketAmount: num(row.return_ticket_amount),
        status: text(row.status),
        toCity: text(row.to_city) || null,
        toDate: dates[dates.length - 1],
        tripId: String(requestIdOfRow(row)),
      };
    }),
  );

  // A copy is named for where it stands: one he already approved, or another that still waits.
  const word = (row: ClaimRow) => (/accept|approve|confirm/i.test(text(row.status)) ? "approved" : "waiting");
  const name = (ids: string[]) => [...new Set(ids.map((id) => byId.get(id)).filter((row): row is ClaimRow => Boolean(row)).map((row) => claimInWords(row, word(row))))];
  // A day is claimed once (owner, 2026-11-23): another live TRIP of the same person on any of this
  // trip's days pays that day twice. A desk flag only - the filing guard stays on day + destination,
  // because every same-day pair it was measured on went to two different places.
  const liveTrips = dated.filter((row) => isTripClaim(text(row.expense_type)) && !NOT_CLAIMING.test(text(row.status)));
  const sharedDays = (subject: ClaimRow, named: ReadonlySet<string>) => {
    if (!isTripClaim(text(subject.expense_type))) return [];
    const mine = new Set(tripDatesOfRow(subject));
    return liveTrips
      .filter((other) => requestIdOfRow(other) !== requestIdOfRow(subject) && person(other) === person(subject))
      .filter((other) => !named.has(String(requestIdOfRow(other))))
      .map((other) => ({ other, shared: tripDatesOfRow(other).filter((day) => mine.has(day)) }))
      .filter(({ shared }) => shared.length > 0)
      .map(({ other, shared }) => ({ id: requestIdOfRow(other), words: `${daysInWords(shared)} with ${claimInWords(other, word(other))}` }));
  };

  const out = new Map<number, DuplicateFinding>();
  for (const id of subjectIds) {
    const tripCopies = trips.get(String(id)) ?? [];
    const ticketCopies = tickets.get(String(id)) ?? [];
    const subject = byId.get(String(id));
    const days = subject ? sharedDays(subject, new Set([...tripCopies, ...ticketCopies])) : [];
    if (tripCopies.length === 0 && ticketCopies.length === 0 && days.length === 0) continue;
    out.set(id, {
      days: [...new Set(days.map((entry) => entry.words))],
      related: [...new Set([...tripCopies, ...ticketCopies].map(Number).concat(days.map((entry) => entry.id)))],
      tickets: name(ticketCopies),
      trips: name(tripCopies),
    });
  }
  return out;
}

/**
 * Where each waiting CAR trip's odometer stands against the same person's earlier car trips (owner,
 * 2026-11-23). The anchor is the latest earlier live car trip whose photo was read - its departure
 * reading, else its arrival reading - and the driving paid since then is that trip's way back, both
 * ways of every car trip in between, and this trip's way out: the fuel was priced on exactly those
 * one-way kilometres. A car that drove less than that between two readings did not make those trips
 * from home (claims 162 and 163; two trips chained without going home). Null paid kilometres when any
 * of those trips carries no distance. Pure.
 */
export function findOdometerChains(subjects: ReadonlyArray<ClaimRow>, others: ReadonlyArray<ClaimRow>): Map<number, OdometerChain> {
  const isCar = (row: ClaimRow) => text(row.transportation_type).toLowerCase() === "car";
  const first = (row: ClaimRow) => tripDatesOfRow(row)[0] ?? "";
  const pool = [...subjects, ...others].filter((row) => isCar(row) && first(row) && !NOT_CLAIMING.test(text(row.status)));
  const lastReading = (row: ClaimRow): number | null => {
    const { arrival, departure } = odometerReadingsOfRow(row);
    if (departure?.status === "read" && departure.km !== null) return departure.km;
    return arrival?.status === "read" ? arrival.km : null;
  };
  const before = (left: ClaimRow, right: ClaimRow) =>
    first(left) < first(right) || (first(left) === first(right) && requestIdOfRow(left) < requestIdOfRow(right));

  const out = new Map<number, OdometerChain>();
  for (const subject of subjects) {
    if (!isCar(subject) || !first(subject)) continue;
    const earlier = pool
      .filter((row) => person(row) === person(subject) && requestIdOfRow(row) !== requestIdOfRow(subject) && before(row, subject))
      .sort((left, right) => (before(left, right) ? 1 : before(right, left) ? -1 : 0));
    let paid: number | null = oneWayKmOfRow(subject);
    let anchor: OdometerChain["anchor"] = null;
    for (const row of earlier) {
      const km = lastReading(row);
      const oneWay = oneWayKmOfRow(row);
      if (km !== null) {
        anchor = { date: first(row), km };
        paid = paid === null || oneWay === null ? null : paid + oneWay;
        break;
      }
      paid = paid === null || oneWay === null ? null : paid + 2 * oneWay;
    }
    out.set(requestIdOfRow(subject), { anchor, paidKmSinceAnchor: anchor ? paid : null });
  }
  return out;
}

function evidenceTripOf(row: ClaimRow): FieldEvidenceTrip {
  return {
    claimedKm: num(row.distance_from_residence_km),
    dates: tripDatesOfRow(row),
    destination: pointOf(row.captured_latitude, row.captured_longitude),
    home: pointOf(row.residence_latitude, row.residence_longitude),
    hrId: text(row.employee_hr_id) || null,
    isCar: text(row.transportation_type).toLowerCase() === "car",
    requestId: requestIdOfRow(row),
  };
}

export async function withLiveNames(claims: DeskClaim[]): Promise<DeskClaim[]> {
  return withLiveOutstationEmployeeNames(
    claims,
    (claim) => ({ hrId: claim.hrId, storedName: claim.employeeName }),
    (claim, employeeName) => ({ ...claim, employeeName }),
  );
}

/** Builds waiting claims from their rows: one Phoenix CRM read for all of them, then the checks. */
async function buildWaitingClaims(input: {
  decided: ReadonlyArray<ClaimRow>;
  lastPaidPayout: PayoutPeriod | null;
  ledger: ReadonlyMap<string, LedgerRow>;
  now: Date;
  rows: ReadonlyArray<ClaimRow>;
}): Promise<{ claims: DeskClaim[]; evidence: FieldEvidence }> {
  const today = currentCairoDateOnlyIso(input.now);
  const trips = input.rows.filter((row) => isTripClaim(text(row.expense_type))).map(evidenceTripOf);
  const evidence = await loadFieldEvidence(trips);
  const duplicates = findDuplicates(input.rows, input.decided);
  const chains = findOdometerChains(input.rows, input.decided);
  const claims = input.rows.map((row) => {
    const id = requestIdOfRow(row);
    const found = duplicates.get(id);
    return buildDeskClaim({
      context: {
        duplicateTickets: found?.tickets ?? [],
        duplicateTrips: found?.trips ?? [],
        fieldWork: evidence.byRequest.get(id) ?? null,
        lastPaidPayout: input.lastPaidPayout,
        odometerChain: chains.get(id),
        sharedTripDays: found?.days ?? [],
        today,
      },
      ledger: input.ledger.get(outstationPayrollTripId(id)) ?? null,
      now: input.now,
      relatedRequestIds: found?.related ?? [],
      row,
    });
  });
  return { claims: await withLiveNames(claims), evidence };
}

export async function loadDeskQueue(access: AccessContext, options: { canDecide: boolean; now?: Date }): Promise<DeskQueue> {
  const now = options.now ?? new Date();
  const accessFilter = await resolveExpenseAccessFilter(access);
  const supabase = await rowSecurityClientFor("outstation.approvalsDesk");

  const [waitingRows, decidedRows, ledger, lastPaidPayout] = await Promise.all([
    readClaimRows(supabase, accessFilter, DESK_CLAIM_COLUMNS, "waiting"),
    readClaimRows(supabase, accessFilter, DECIDED_CLAIM_COLUMNS, "decided"),
    readLedger(supabase),
    readLastPaidPayout(supabase),
  ]);

  // A decided claim with no payroll row is HELD and pays its own claim, so it needs its figures;
  // one whose status nobody listed is shown as waiting rather than hidden. Both are a handful.
  const ledgerOf = (row: ClaimRow) => ledger.get(outstationPayrollTripId(requestIdOfRow(row))) ?? null;
  const needFull = decidedRows.filter((row) => {
    const standing = standingOfRow(row, ledgerOf(row));
    return standing === "approved_held" || standing === "waiting";
  });
  const fullRows = await readClaimRows(supabase, accessFilter, DESK_CLAIM_COLUMNS, { ids: needFull.map(requestIdOfRow) });
  const unlisted = fullRows.filter((row) => standingOfRow(row, ledgerOf(row)) === "waiting");
  const held = fullRows.filter((row) => standingOfRow(row, ledgerOf(row)) === "approved_held");
  const unlistedIds = new Set(unlisted.map(requestIdOfRow));

  const { claims, evidence } = await buildWaitingClaims({
    decided: decidedRows.filter((row) => !unlistedIds.has(requestIdOfRow(row))),
    lastPaidPayout,
    ledger,
    now,
    rows: [...waitingRows, ...unlisted],
  });

  const today = currentCairoDateOnlyIso(now);
  const heldPayable = new Map(
    held.map((row) => [requestIdOfRow(row), buildDeskClaim({ context: { today }, ledger: null, now, row }).payable]),
  );
  const tiles = countTripStandings([
    ...claims.map((claim) => ({ payable: claim.payable, standing: claim.standing })),
    ...decidedRows
      .filter((row) => !unlistedIds.has(requestIdOfRow(row)))
      .map((row) => {
        const stored = ledgerOf(row);
        const standing = standingOfRow(row, stored, lastPaidPayout);
        const payable = stored ? payableExpenseAmount(stored.approved_amount, stored.total) : (heldPayable.get(requestIdOfRow(row)) ?? 0);
        return { payable, standing };
      }),
  ]);

  return {
    agreement: summarizeAgreement(
      decidedRows.map((row) => ({ lane: row.system_lane_at_decision, stamp: row.system_verdict_at_decision })),
      now,
    ),
    canDecide: options.canDecide,
    // Oldest first: the claim that has waited longest is the one to decide.
    claims: claims.sort((left, right) => String(left.submittedAt ?? "").localeCompare(String(right.submittedAt ?? ""))),
    overSevenDays: claims.filter((claim) => claim.daysWaiting > 7).length,
    tiles,
    unavailable: evidence.unavailable,
  };
}

/**
 * Claims as they read NOW, by id — before a decision is applied, after it, and for the reviewer.
 * Scope is checked the same two ways; a claim outside the viewer's scope is simply not in the map.
 * A claim that still waits gets its checks again, from one Phoenix CRM read for all of them.
 */
export async function loadDeskClaims(access: AccessContext, requestIds: ReadonlyArray<number>, now: Date = new Date()): Promise<Map<number, DeskClaim>> {
  const ids = [...new Set(requestIds.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, DeskClaim>();
  if (ids.length === 0) return out;

  const accessFilter = await resolveExpenseAccessFilter(access);
  const supabase = await rowSecurityClientFor("outstation.approvalsDeskClaims");
  const [rows, ledger, lastPaidPayout] = await Promise.all([
    readClaimRows(supabase, accessFilter, DESK_CLAIM_COLUMNS, { ids }),
    readLedger(supabase, ids.map((id) => outstationPayrollTripId(id))),
    readLastPaidPayout(supabase),
  ]);
  const ledgerOf = (row: ClaimRow) => ledger.get(outstationPayrollTripId(requestIdOfRow(row))) ?? null;
  const waiting = rows.filter((row) => standingOfRow(row, ledgerOf(row)) === "waiting");
  const decided = rows.filter((row) => standingOfRow(row, ledgerOf(row)) !== "waiting");

  const today = currentCairoDateOnlyIso(now);
  const decidedClaims = await withLiveNames(decided.map((row) => buildDeskClaim({ context: { lastPaidPayout, today }, ledger: ledgerOf(row), now, row })));
  for (const claim of decidedClaims) out.set(claim.requestId, claim);
  if (waiting.length === 0) return out;

  // The same employees' other claims, for the duplicate check. They belong to people whose claims
  // already passed the scope check above.
  const waitingIds = new Set(waiting.map(requestIdOfRow));
  const people = [...new Set(waiting.map((row) => text(row.employee_hr_id)).filter(Boolean))];
  let others: ClaimRow[] = [];
  if (people.length > 0) {
    const build = () =>
      applyEmployeeHrIdInFilter(supabase.from(REQUESTS).select(DECIDED_CLAIM_COLUMNS).order("id", { ascending: true }), people);
    const { data, error } = await fetchAllRows((from, to) => build().range(from, to));
    if (error) throw error;
    others = ((data ?? []) as unknown as ClaimRow[]).filter((row) => !waitingIds.has(requestIdOfRow(row)));
  }
  const { claims } = await buildWaitingClaims({ decided: others, lastPaidPayout, ledger, now, rows: waiting });
  for (const claim of claims) out.set(claim.requestId, claim);
  return out;
}

export async function loadDeskClaim(access: AccessContext, requestId: number, now: Date = new Date()): Promise<DeskClaim | null> {
  return (await loadDeskClaims(access, [requestId], now)).get(requestId) ?? null;
}
