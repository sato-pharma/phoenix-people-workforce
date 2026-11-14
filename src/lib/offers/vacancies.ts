import { getOpenWorkforceVacanciesOrThrow } from "@/lib/employees/vacancy-closer";
import { logError } from "@/lib/observability/log";
import type { OfferVacancyOption } from "@/lib/offers/types";
import { classifyOfferVacancy, type OfferVacancyCheck, type OpenVacancyRead } from "@/lib/offers/vacancy-check";

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
  const read = await readOfferVacancies();
  // The picker is a convenience on a screen whose real job is sending a letter. A vacancy read that
  // fails must not take the Offers page down with it — the seat field simply offers nothing, and
  // every other part of the composer still works. A caller that must tell "no seats" from "could
  // not read the seats" uses readOfferVacancies() or checkOfferVacancy() instead (REC-034).
  return read.ok ? read.options : [];
}

/**
 * The open seats, or { ok: false } when they could not be read (REC-034, 14 Nov 2026). Never an
 * empty list for a failed read: an empty list means "every seat is filled", and the joining form,
 * the hire draft and the Offers screen each turned that into "the seat on this offer is gone".
 */
export async function readOfferVacancies(): Promise<OpenVacancyRead> {
  try {
    return { ok: true, options: await loadOfferVacancyOptionsStrict() };
  } catch (error) {
    logError("The open vacancies could not be read for an offer", {
      error,
      labels: { event: "offer_vacancy_read_failed" },
    });
    return { ok: false };
  }
}

/**
 * Where the seat an offer names stands: open (with the seat), closed, none named, or unread.
 * See vacancy-check.ts — `unread` is never `closed`.
 */
export async function checkOfferVacancy(vacancyId: number | null | undefined): Promise<OfferVacancyCheck> {
  if (!vacancyId) return { status: "none" };
  return classifyOfferVacancy(vacancyId, await readOfferVacancies());
}

/** The open seats, throwing when they cannot be read. */
async function loadOfferVacancyOptionsStrict(): Promise<OfferVacancyOption[]> {
  const rows = await getOpenWorkforceVacanciesOrThrow();
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
}

/** Line, then position, then area — the order somebody hunting for a seat reads them in. */
function compareOfferVacancies(a: OfferVacancyOption, b: OfferVacancyOption): number {
  const byLine = (a.lineName ?? "").localeCompare(b.lineName ?? "");
  if (byLine !== 0) return byLine;
  const byPosition = (a.positionTitle ?? a.jobTitle ?? "").localeCompare(b.positionTitle ?? b.jobTitle ?? "");
  if (byPosition !== 0) return byPosition;
  return (a.areaName ?? "").localeCompare(b.areaName ?? "");
}
