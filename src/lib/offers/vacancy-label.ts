import type { OfferVacancyOption } from "@/lib/offers/types";

/**
 * How an open seat reads on the offers screen:
 * `Pedia · Medical Representative · Alex East (Alex-BHR) · Manager: Mohamed Alaa`.
 *
 * ── Why this is its own file ──
 * The composer is a client component, and `src/lib/offers/vacancies.ts` — where the seats are
 * READ — reaches `src/lib/employees/vacancy-closer.ts`, which needs the service-role key and
 * React's server-side `cache()`. Importing the label from there would drag all of that into the
 * browser bundle. The label is pure, so it lives apart and the reader re-exports it; one spelling
 * of a seat, on the screen and in the API.
 *
 * ── Why it names the LINE, where the hire form's label does not ──
 * `formatVacancyOptionLabel` (the Add Employee picker) is already filtered to one line and one
 * position by the fields above it. This list is not filtered by anything: production holds 42 open
 * Medical Representative seats across three lines, and Alex West appears on two of them. Without
 * the line the rows are indistinguishable.
 *
 * Every segment is dropped when its value is missing, so a seat with no manager yet does not trail
 * an empty "Manager:". No ellipsis anywhere — the owner's standing rule is that text is never cut
 * off, and a half-shown seat is exactly the failure that rule exists to prevent.
 */
export function formatOfferVacancyLabel(vacancy: OfferVacancyOption): string {
  const position = (vacancy.positionTitle || vacancy.jobTitle || "").trim();
  const area = (vacancy.areaName ?? "").trim();
  const region = (vacancy.regionName ?? "").trim();
  const manager = (vacancy.managerName ?? "").trim();

  // A single-area district would otherwise print its own name twice ("Cairo (Cairo)").
  const place = !area ? region : !region || region.toLowerCase() === area.toLowerCase() ? area : `${area} (${region})`;

  return [(vacancy.lineName ?? "").trim(), position, place, manager ? `Manager: ${manager}` : ""]
    .filter(Boolean)
    .join(" · ");
}
