import { getOpenWorkforceVacancies } from "@/lib/employees/vacancy-closer";
import type { OfferVacancyOption } from "@/lib/offers/types";

// Re-exported rather than defined here: the label is pure and the composer is a client component,
// while everything else in this file reaches the service-role Supabase client. See vacancy-label.ts.
export { formatOfferVacancyLabel } from "@/lib/offers/vacancy-label";

/**
 * The open seats an offer can be written against.
 *
 * ── Why this import is allowed, when recruitment is not ──
 * `src/lib/employees/vacancy-closer.ts` reads `position_vacancies` — the org's own record of which
 * chairs are empty. It is shared HR data, it has never depended on recruitment or on offers, and an
 * offer pointing at a SEAT says nothing about whether the person receiving it is in the ATS. The
 * rule the offers module lives under is that it must not learn a CANDIDATE exists
 * (`tests/candidate-offer-pointer.test.ts`), and a vacancy is not a candidate.
 *
 * ── Only OPEN seats, always re-read ──
 * Nothing here is cached beyond the per-request memo the closer already holds. A seat filled
 * between writing an offer and accepting it must stop being offered the moment it is filled, and a
 * stale list would carry a new hire towards a chair somebody is already sitting in.
 *
 * ── An offer does NOT reserve the seat ──
 * Choosing a seat on an offer records intent; it does not take the vacancy off the list. Two
 * letters may name the same seat — which is what happens when the first candidate is expected to
 * decline — and the seat is closed by the HIRE, as it always has been
 * (`closeVacancyOnHire`). Reserving would change headcount behaviour, and the organogram skeleton
 * is the owner's alone.
 */
export async function loadOfferVacancyOptions(): Promise<OfferVacancyOption[]> {
  try {
    const rows = await getOpenWorkforceVacancies();
    return rows
      .map((row) => ({
        areaId: row.areaId,
        areaName: row.areaName,
        departmentId: row.departmentId,
        jobTitle: row.jobTitle,
        lineId: row.lineId,
        lineName: row.lineName,
        managerHrId: row.managerHrId,
        managerName: row.managerName,
        positionId: row.positionId,
        positionTitle: row.positionTitle,
        regionName: row.regionName,
        vacancyCode: row.vacancyCode,
        vacancyId: row.vacancyId,
      }))
      .sort(compareOfferVacancies);
  } catch {
    // The picker is a convenience on a screen whose real job is sending a letter. A vacancy read
    // that fails must not take the Offers page down with it — the seat field simply offers nothing,
    // and every other part of the composer still works. The closer already swallows the timeouts
    // and schema-cache cases; this catches the rest.
    return [];
  }
}

/** Line, then position, then area — the order somebody hunting for a seat reads them in. */
function compareOfferVacancies(a: OfferVacancyOption, b: OfferVacancyOption): number {
  const byLine = (a.lineName ?? "").localeCompare(b.lineName ?? "");
  if (byLine !== 0) return byLine;
  const byPosition = (a.positionTitle ?? a.jobTitle ?? "").localeCompare(b.positionTitle ?? b.jobTitle ?? "");
  if (byPosition !== 0) return byPosition;
  return (a.areaName ?? "").localeCompare(b.areaName ?? "");
}

/**
 * The seat an offer points at, or null — and null is the answer for a seat that has since been
 * FILLED, not only for an offer that never named one.
 *
 * That collapse is deliberate and is the whole reason this is a lookup rather than a read of the
 * stored id. Between an offer being written and being accepted, somebody else may have been hired
 * into the seat; pre-selecting it then would aim the new hire at an occupied chair and leave the
 * vacancy closer with nothing to close. A seat that is gone reads exactly like a seat that was
 * never chosen, and the form's own picker is where that is settled.
 */
export async function findOpenOfferVacancy(vacancyId: number | null): Promise<OfferVacancyOption | null> {
  if (!vacancyId) return null;
  const options = await loadOfferVacancyOptions();
  return options.find((option) => option.vacancyId === vacancyId) ?? null;
}

