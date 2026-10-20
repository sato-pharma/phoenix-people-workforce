// Recruitment workspace — "Mark as hired": which vacant seat this person takes, and the link that
// opens Employee Master's Add Employee on that seat with the person already in the form.
//
// THE WORKSPACE NEVER WRITES "HIRED" ITSELF (owner's plan, Phase 4, 20 Oct 2026). A plain status
// write left the seat open, the requisition open and no employee record, so the funnel said hired and
// the organogram said vacant. A hire is now ONE thing: the real Add Employee form saves the employee,
// the vacancy chain fills the seat on that insert, and `recordHireFromCandidate`
// (offer-outcome-sync.ts) — called by the employees route in the same request — moves the candidate
// to Hired and closes the seat's requisition. This file only chooses the seat and builds the link.
//
// WHICH SEATS ARE OFFERED, in this order:
//   1. a REP seat in the AU area the applicant replied with;
//   2. a district-manager seat in the region they replied with (UE-1/UE-2 count under Upper Egypt,
//      the same fold the workspace's places use);
//   3. any other open seat whose title is the same role tab;
//   and when none of those exist — or the applicant was never placed — every open seat, so filing
//   can narrow a hire but never block one.
// A vacancy whose org-tree seat reads OCCUPIED is never offered: `position_vacancies` can lag the
// seat model by a seat move, and hiring into a filled chair is the one wrong answer here. A vacancy
// with no seat at all (Product Manager, Training Manager today) is kept — those chairs are real,
// they are just not on the sales tree.
//
// ONLY `employees:update` CAN FINISH A HIRE. The Talent Acquisition seat has no employees grant, so
// she sees the button greyed with the reason, never a link Employee Master would refuse.
//
// The ranking is PURE (`rankHireSeats`) so `tests/recruitment-hire-from-candidate` pins it without a
// database.

import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { getOpenWorkforceVacancies, type VacancyLookupRow } from "@/lib/employees/vacancy-closer";
import { buildSeatHireHref, formatVacancySeatLabel } from "@/lib/employees/vacancy-hire-link";
import { getCandidate } from "@/lib/recruitment/candidates";
import { candidateRoleFamily } from "@/lib/recruitment/candidate-role-family";
import { linkedOfferFor } from "@/lib/recruitment/candidate-offer-link";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { FROM_CANDIDATE_PARAM } from "@/lib/recruitment/workspace/links";
import { recruitmentRegionForSeatRegion } from "@/lib/recruitment/workspace/places";
import { listPlacementsFor } from "@/lib/recruitment/workspace/placements-db";
import { roleTabForFamily, type WorkspaceRoleTab } from "@/lib/recruitment/workspace/role-tabs";

/** Shown on the greyed button to anyone without the employees grant. */
export const HIRE_NEEDS_EMPLOYEE_MASTER = "Only Employee Master can complete a hire";
export const HIRE_ALREADY_HIRED = "This candidate is already hired.";

/** Employee Master's own page — the admin shell's Add Employee lives here. */
const EMPLOYEES_PATH = "/employees";

const DM_TIERS = new Set(["DM", "ACTING_DM"]);

export type HireSeatMatch = "area" | "region" | "title" | "any";

/** One open vacancy, with what the seat model says about its chair. */
export type HireSeatCandidate = {
  vacancyId: string;
  /** "Medical Representative · Alex-BHR · CNS". */
  label: string;
  /** The tab the vacancy's own title files under (from the title, never from a person). */
  tab: WorkspaceRoleTab | null;
  seatTier: string | null;
  areaCode: string | null;
  regionCode: string | null;
  /** The org-tree's word on the chair: false = occupied, null = no seat on the tree. */
  seatVacant: boolean | null;
};

/** Where the applicant's own replies filed them — one per tab they are in. */
export type HirePlacement = {
  roleTab: WorkspaceRoleTab;
  regionCode: string | null;
  areaCode: string | null;
};

export type HireSeatOption = { vacancyId: string; label: string; match: HireSeatMatch };

const MATCH_SUFFIX: Record<HireSeatMatch, string> = {
  any: "",
  area: " — in their area",
  region: " — in their region",
  title: "",
};

function same(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a ?? "").trim().toUpperCase();
  return left.length > 0 && left === String(b ?? "").trim().toUpperCase();
}

/**
 * The seats to offer, best first. PURE.
 *
 * Occupied chairs are dropped before anything else. With placements, the three buckets above in
 * order, each seat once; with no placement, or when no bucket holds a seat, every open seat.
 */
export function rankHireSeats(placements: readonly HirePlacement[], seats: readonly HireSeatCandidate[]): HireSeatOption[] {
  const open = seats.filter((seat) => seat.seatVacant !== false);
  const byLabel = (a: HireSeatCandidate, b: HireSeatCandidate) => a.label.localeCompare(b.label);
  const everything = () => [...open].sort(byLabel).map((seat) => ({ label: seat.label, match: "any" as const, vacancyId: seat.vacancyId }));
  if (placements.length === 0) return everything();

  const chosen = new Map<string, HireSeatOption>();
  const take = (match: HireSeatMatch, keep: (seat: HireSeatCandidate) => boolean) => {
    for (const seat of [...open].sort(byLabel)) {
      if (chosen.has(seat.vacancyId) || !keep(seat)) continue;
      chosen.set(seat.vacancyId, { label: `${seat.label}${MATCH_SUFFIX[match]}`, match, vacancyId: seat.vacancyId });
    }
  };

  for (const placement of placements) {
    if (placement.areaCode) {
      take("area", (seat) => String(seat.seatTier ?? "").toUpperCase() === "REP" && same(seat.areaCode, placement.areaCode));
    }
  }
  for (const placement of placements) {
    if (placement.regionCode) {
      take(
        "region",
        (seat) =>
          DM_TIERS.has(String(seat.seatTier ?? "").toUpperCase()) &&
          recruitmentRegionForSeatRegion(seat.regionCode) === String(placement.regionCode).toUpperCase(),
      );
    }
  }
  for (const placement of placements) {
    take("title", (seat) => seat.tab === placement.roleTab);
  }

  return chosen.size > 0 ? [...chosen.values()] : everything();
}

/** A vacancy's label, without the reader's "Unknown Area"/"Unknown Line" placeholders. */
function seatLabel(row: VacancyLookupRow): string {
  const known = (value: string | null, placeholder: string) => (value && value !== placeholder ? value : null);
  return (
    formatVacancySeatLabel({
      areaName: known(row.areaName, "Unknown Area"),
      jobTitle: row.jobTitle,
      lineName: known(row.lineName, "Unknown Line"),
      positionTitle: row.positionTitle,
    }) || row.vacancyCode
  );
}

/** Every open vacancy, joined to its chair on the org tree. */
async function loadHireSeats(): Promise<{ seats: HireSeatCandidate[]; rows: Map<string, VacancyLookupRow> }> {
  const vacancies = await getOpenWorkforceVacancies();
  const rows = new Map(vacancies.map((row) => [String(row.vacancyId), row]));
  const supabase = recruitmentDb();

  const seatIdByVacancy = new Map<string, string>();
  for (const batch of chunkIds(Array.from(rows.keys()))) {
    const { data, error } = await supabase.from("position_vacancies").select("id,seat_id").in("id", batch);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ id: number | string; seat_id: string | null }>) {
      const seatId = textOrNull(row.seat_id);
      if (seatId) seatIdByVacancy.set(String(row.id), seatId);
    }
  }

  const chairs = new Map<string, { seat_tier: string | null; area_code: string | null; region_code: string | null; is_vacant: boolean | null }>();
  for (const batch of chunkIds(Array.from(new Set(seatIdByVacancy.values())))) {
    const { data, error } = await supabase
      .from("au_v_org_tree")
      .select("seat_id,seat_tier,area_code,region_code,is_vacant")
      .in("seat_id", batch);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Array<{ seat_id: string; seat_tier: string | null; area_code: string | null; region_code: string | null; is_vacant: boolean | null }>) {
      chairs.set(String(row.seat_id), row);
    }
  }

  const seats = vacancies.map((row): HireSeatCandidate => {
    const chair = chairs.get(seatIdByVacancy.get(String(row.vacancyId)) ?? "");
    return {
      areaCode: textOrNull(chair?.area_code),
      label: seatLabel(row),
      regionCode: textOrNull(chair?.region_code),
      seatTier: textOrNull(chair?.seat_tier),
      seatVacant: chair ? chair.is_vacant !== false : null,
      tab: roleTabForFamily(candidateRoleFamily(row.positionTitle || row.jobTitle)),
      vacancyId: String(row.vacancyId),
    };
  });
  return { rows, seats };
}

export type HireOptions = {
  canHire: boolean;
  reason: string | null;
  seats: HireSeatOption[];
  /** Add Employee through the accepted letter, when the candidate has one — the letter's own door. */
  offerHref: string | null;
};

/** The accepted letter's id, when this candidate points at one. */
async function acceptedOfferId(candidate: { offerId: string | null }): Promise<string | null> {
  const offer = await linkedOfferFor(candidate);
  return offer && offer.status === "accepted" ? offer.id : null;
}

/** What the "Mark as hired" dialog shows for this candidate and this viewer. */
export async function loadHireOptions(access: AccessContext, candidateId: string): Promise<HireOptions> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) throw new Error("Candidate not found.");

  const canUpdateEmployees = await canAccess(access, "employees", "update");
  const offerId = await acceptedOfferId(candidate);
  const offerHref = offerId ? `${EMPLOYEES_PATH}?fromOffer=${encodeURIComponent(offerId)}` : null;
  if (candidate.status === "hired") {
    return { canHire: false, offerHref: null, reason: HIRE_ALREADY_HIRED, seats: [] };
  }
  if (!canUpdateEmployees) {
    return { canHire: false, offerHref: null, reason: HIRE_NEEDS_EMPLOYEE_MASTER, seats: [] };
  }

  const [{ seats }, placementMap] = await Promise.all([loadHireSeats(), listPlacementsFor([candidate.id])]);
  const placements: HirePlacement[] = (placementMap.get(candidate.id) ?? []).map((placement) => ({
    areaCode: placement.areaCode ?? null,
    regionCode: placement.regionCode ?? null,
    roleTab: placement.roleTab,
  }));
  return { canHire: true, offerHref, reason: null, seats: rankHireSeats(placements, seats) };
}

/**
 * The Add Employee link for this candidate in this seat. Writes NOTHING — the form saves.
 *
 * An ACCEPTED letter wins, exactly as on the organogram (`buildSeatHireHref`): its door fills the
 * agreed net and reads this candidate's CV back through the letter's pointer, and its own hire door
 * (`recordHireFromOfferLetter`) marks the candidate. Otherwise the seat prefill plus `fromCandidate`.
 */
export async function buildCandidateHireHref(candidateId: string, vacancyId: string): Promise<string> {
  const candidate = await getCandidate(candidateId);
  if (!candidate) throw new Error("Candidate not found.");
  if (candidate.status === "hired") throw new Error(HIRE_ALREADY_HIRED);

  const { rows, seats } = await loadHireSeats();
  const row = rows.get(String(vacancyId));
  const seat = seats.find((entry) => entry.vacancyId === String(vacancyId));
  // Checked against the open list, not trusted from the body: a seat filled since the dialog opened
  // must not open a form for a chair that is no longer there.
  if (!row || !seat || seat.seatVacant === false) {
    throw new Error("That seat is no longer open — choose another.");
  }

  const offerId = await acceptedOfferId(candidate);
  const href = buildSeatHireHref(EMPLOYEES_PATH, row, offerId ? { offerId, status: "accepted" } : null);
  if (offerId) return href;
  return `${href}&${FROM_CANDIDATE_PARAM}=${encodeURIComponent(candidate.id)}`;
}
