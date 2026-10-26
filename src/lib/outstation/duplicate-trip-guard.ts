/**
 * The same-trip guard: one employee cannot claim the same trip — same day, same destination —
 * twice.
 *
 * Owner-reported (Pedia NSM page audit, 2026-10-26): OUTSTATION-292 and OUTSTATION-293 are one
 * District Manager's one drive, Sohag → Assiut on 22 Oct 2026, submitted 14 minutes apart. 292
 * was already confirmed by HR; 293 sat in the queue asking for a second 312 EGP fuel line for
 * the same 86.7 km. The allowance guard (allowance-day-guard.ts) had already zeroed the second
 * allowance, but fuel, tickets and meeting cost have no such guard, so the copy still claimed
 * real money.
 *
 * Two halves, one rule:
 *  - SUBMISSION refuses the copy with words that name the earlier claim (submitOutstationRequest
 *    in service.ts, which the offline replay also goes through). It is a refusal in the app, never
 *    a database constraint: an employee is told which claim already covers the trip and what to
 *    do, which a unique constraint cannot say.
 *  - The APPROVALS screen flags every pair already in the table, so the ones submitted before
 *    this guard existed are decided knowingly (expense-approvals-workspace.tsx).
 *
 * The payroll duplicate HOLD (automated-payroll/duplicate-expense-hold.ts) is a separate, later
 * net and is unchanged: it holds an extra copy of an imported or already-stored claim instead of
 * paying it twice.
 *
 * Pure and synchronous, like allowance-day-guard.ts: the read that feeds it lives in service.ts.
 */

/** A claim's request id → how every screen names it. */
export function outstationClaimRef(requestId: number | string) {
  return `OUTSTATION-${requestId}`;
}

/** One trip, as the guard compares it. */
export type DuplicateTripCandidate = {
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  employeeHrId: string;
  expenseType?: string | null;
  toArea?: string | null;
  toCity?: string | null;
  tripStartDate: string;
};

export type DuplicateTripExisting = DuplicateTripCandidate & {
  id: number;
  status: string;
};

/**
 * Statuses that no longer claim anything. A refused claim never paid, so it must not block the
 * employee from claiming the trip properly — the same reading allowance-day-guard.ts takes.
 */
const NON_CLAIMING_STATUSES = new Set(["rejected_by_system", "rejected_by_admin", "draft", "cancelled", "withdrawn"]);

/** Meeting and Other claims are not trips (non-travel-expense.ts) — several on a day are normal. */
const NON_TRAVEL_TYPES = new Set(["meeting", "other"]);

/**
 * Two captured points this close are the same place. Small on purpose: only used when a side has
 * no area or city name, and the ten same-day pairs on production that went to DIFFERENT areas sit
 * 0.5 to 10 km apart.
 */
export const SAME_PLACE_KM = 1;

function day(value: string | null | undefined) {
  return String(value ?? "").slice(0, 10);
}

function placeKey(value: string | null | undefined) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\bgovernorate\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Great-circle distance between two captured points, in km. */
export function kmBetween(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Whether two trips go to the same destination. The area decides when both sides have one; the
 * city when either lacks an area; the captured points only when neither name is there to read.
 */
export function sameTripDestination(a: DuplicateTripCandidate, b: DuplicateTripCandidate): boolean {
  const areaA = placeKey(a.toArea);
  const areaB = placeKey(b.toArea);
  if (areaA && areaB) return areaA === areaB;
  const cityA = placeKey(a.toCity);
  const cityB = placeKey(b.toCity);
  if (cityA && cityB) return cityA === cityB;
  if (finite(a.capturedLatitude) && finite(a.capturedLongitude) && finite(b.capturedLatitude) && finite(b.capturedLongitude)) {
    return (
      kmBetween(
        { lat: a.capturedLatitude, lng: a.capturedLongitude },
        { lat: b.capturedLatitude, lng: b.capturedLongitude },
      ) <= SAME_PLACE_KM
    );
  }
  return false;
}

/**
 * The earliest live claim that already covers this trip, or null. `excludeRequestId` is the
 * request being re-submitted itself, which never blocks its own edit.
 */
export function findDuplicateTrip(
  candidate: DuplicateTripCandidate,
  existing: DuplicateTripExisting[],
  excludeRequestId?: number,
): DuplicateTripExisting | null {
  if (NON_TRAVEL_TYPES.has(String(candidate.expenseType ?? "").toLowerCase())) return null;
  const hrId = candidate.employeeHrId.trim().toLowerCase();
  const tripDay = day(candidate.tripStartDate);
  if (!hrId || !tripDay) return null;

  const matches = existing
    .filter((row) => row.id !== excludeRequestId)
    .filter((row) => !NON_CLAIMING_STATUSES.has(row.status))
    .filter((row) => !NON_TRAVEL_TYPES.has(String(row.expenseType ?? "").toLowerCase()))
    .filter((row) => row.employeeHrId.trim().toLowerCase() === hrId && day(row.tripStartDate) === tripDay)
    .filter((row) => sameTripDestination(candidate, row))
    .sort((a, b) => a.id - b.id);
  return matches[0] ?? null;
}

function formatTripDay(iso: string) {
  const date = new Date(`${day(iso)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day(iso);
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", year: "numeric" });
}

/** The words an employee reads when the copy is refused. */
export function duplicateTripMessage(earlier: DuplicateTripExisting) {
  const where = String(earlier.toArea || earlier.toCity || "").trim();
  return (
    `This trip is already claimed on ${outstationClaimRef(earlier.id)} — ${formatTripDay(earlier.tripStartDate)}` +
    `${where ? `, ${where}` : ""}. One trip is claimed once, so this second claim was not submitted. ` +
    `If something on ${outstationClaimRef(earlier.id)} is wrong, ask HR to correct or reject it, then claim again.`
  );
}

/** One row of the approvals screen, as the pair flag reads it. */
export type DuplicateTripRow = {
  capturedLatitude?: number | null;
  capturedLongitude?: number | null;
  date: string;
  hrId?: string | null;
  location?: string | null;
  status?: string | null;
  to?: string | null;
  tripId: string;
  tripType?: string | null;
};

function sameCapturedPlace(a: DuplicateTripRow, b: DuplicateTripRow) {
  if (!finite(a.capturedLatitude) || !finite(a.capturedLongitude) || !finite(b.capturedLatitude) || !finite(b.capturedLongitude)) {
    return false;
  }
  return (
    kmBetween({ lat: a.capturedLatitude, lng: a.capturedLongitude }, { lat: b.capturedLatitude, lng: b.capturedLongitude }) <=
    SAME_PLACE_KM
  );
}

function sameRowDestination(a: DuplicateTripRow, b: DuplicateTripRow) {
  const placeA = placeKey(a.location || a.to);
  const placeB = placeKey(b.location || b.to);
  return (placeA !== "" && placeA === placeB) || sameCapturedPlace(a, b);
}

/**
 * Pairs on the approvals screen: every live row that shares an employee, a day and a destination
 * with another live row, mapped to the OTHER rows' trip ids. A rejected row is no copy — once HR
 * refused it the other claim is the trip. A flag is a review signal, never a decision: nothing is
 * refused or held by it.
 */
export function flagDuplicateTripRows(rows: DuplicateTripRow[]): Map<string, string[]> {
  const groups = new Map<string, DuplicateTripRow[]>();
  for (const row of rows) {
    const hrId = String(row.hrId ?? "").trim().toLowerCase();
    const tripDay = day(row.date);
    if (!hrId || !tripDay || !row.tripId) continue;
    if (NON_TRAVEL_TYPES.has(String(row.tripType ?? "").toLowerCase())) continue;
    if (/reject|declin/i.test(String(row.status ?? ""))) continue;
    const key = `${hrId}|${tripDay}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const flags = new Map<string, string[]>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      const copies = group
        .filter((other) => other.tripId !== row.tripId && sameRowDestination(row, other))
        .map((other) => other.tripId);
      if (copies.length > 0) flags.set(row.tripId, copies);
    }
  }
  return flags;
}
