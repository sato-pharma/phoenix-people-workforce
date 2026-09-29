/**
 * The candidates a seat can be filled with.
 *
 * Add Employee has two doors and until now they were strictly separate: arriving from an OPEN
 * SEAT filled the placement (line, area, department, position, manager, region) and left the
 * person blank, while arriving from a RECRUITMENT APPLICATION filled the person and their CV
 * and left the placement blank. A real hire into a real vacancy therefore meant typing one half
 * by hand whichever door you came through. This is the list that closes it: given the seat, the
 * candidates who could be hired into it right now.
 *
 * The stage set is deliberately the SAME one the recruitment hub already gates its own "Mark as
 * hired" card on — offer_initiated, offer_accepted, pre_boarding. It is not a new rule, and it
 * must not become one: a candidate who cannot be hired from the hub must not appear hireable
 * here either.
 */

export const SEAT_HIRE_STAGES = [
  "offer_initiated",
  "offer_accepted",
  "pre_boarding",
] as const;

export type SeatHireStage = (typeof SEAT_HIRE_STAGES)[number];

export type SeatHireCandidate = {
  applicationId: string;
  applicationCode: string;
  candidateName: string;
  /** The offer's job title, else the requisition's — what this person was actually offered. */
  jobTitle: string | null;
  stage: string;
  /**
   * Whether the application's own requisition points at the same seat. Matching candidates are
   * offered first, but the others are NOT hidden: a requisition is often opened against one area
   * and the person ends up filling a neighbouring one, and hiding them would send whoever is
   * hiring back to typing the person by hand — the exact problem this list exists to remove.
   */
  matchesSeat: boolean;
};

/** Only the fields of the seat that can identify a requisition. All optional: a Head Office seat
 *  carries no line or area at all. */
export type SeatHireTarget = {
  areaId?: number | string | null;
  lineId?: number | string | null;
  positionId?: number | string | null;
};

/** What this reads off an application. Structural, so the employees module never has to import
 *  the recruitment types to talk about one. */
export type SeatHireApplication = {
  id: string;
  applicationCode?: string | null;
  stage: string;
  convertedEmployeeHrId?: string | null;
  candidate?: { fullName?: string | null } | null;
  requisition?: {
    areaId?: number | string | null;
    jobTitle?: string | null;
    lineId?: number | string | null;
    positionId?: number | string | null;
  } | null;
};

function key(value: number | string | null | undefined) {
  if (value === null || value === undefined) return "";
  const trimmed = String(value).trim();
  return trimmed === "0" ? "" : trimmed;
}

export function isSeatHireStage(stage: string): stage is SeatHireStage {
  return (SEAT_HIRE_STAGES as readonly string[]).includes(stage);
}

/**
 * A requisition matches the seat when every id BOTH sides carry agrees. An id the seat does not
 * carry (a Head Office seat has no area) cannot disagree, so it does not veto — but a match on
 * nothing at all is not a match, which is why `compared` has to be non-zero.
 */
function requisitionMatchesSeat(
  requisition: SeatHireApplication["requisition"],
  seat: SeatHireTarget,
) {
  if (!requisition) return false;

  let compared = 0;
  for (const [left, right] of [
    [key(seat.lineId), key(requisition.lineId)],
    [key(seat.areaId), key(requisition.areaId)],
    [key(seat.positionId), key(requisition.positionId)],
  ]) {
    if (!left || !right) continue;
    compared += 1;
    if (left !== right) return false;
  }

  return compared > 0;
}

export function buildSeatHireCandidates(
  applications: SeatHireApplication[],
  seat: SeatHireTarget,
): SeatHireCandidate[] {
  const rows: SeatHireCandidate[] = [];

  for (const application of applications) {
    if (!isSeatHireStage(application.stage)) continue;
    // Already became an employee. The hub's own card stops offering one at this point and so
    // must this, or the same person is hired twice into two seats.
    if (key(application.convertedEmployeeHrId)) continue;

    const candidateName = String(application.candidate?.fullName ?? "").trim();
    // No candidate record means nothing to pre-fill — the hire-draft endpoint 404s on exactly
    // this case, so offering it would be a button that always fails.
    if (!candidateName) continue;

    rows.push({
      applicationId: application.id,
      applicationCode: String(application.applicationCode ?? "").trim(),
      candidateName,
      jobTitle: String(application.requisition?.jobTitle ?? "").trim() || null,
      matchesSeat: requisitionMatchesSeat(application.requisition, seat),
      stage: application.stage,
    });
  }

  return rows.sort((left, right) => {
    if (left.matchesSeat !== right.matchesSeat) return left.matchesSeat ? -1 : 1;
    return left.candidateName.localeCompare(right.candidateName);
  });
}
