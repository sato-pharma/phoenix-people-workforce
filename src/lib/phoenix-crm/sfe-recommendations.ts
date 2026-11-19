/**
 * Phoenix CRM — the SFE Manager's recommendations on place checks, set apart for the Super Admin.
 *
 * Owner, 19 November 2026: "in place checks make Khaled Bedair only able to recommend validation or not
 * recommend, never able to take a decision, and the recommended by him goes separately in a separate page
 * for admin decision."
 *
 * So a place check or a held building the SFE Manager has recommended on leaves the Super Admin's Needs you
 * list and waits on its own page, `SFE_RECOMMENDATIONS_PATH`, in two lists: recommended to validate, and
 * not recommended. The Super Admin decides there with the same controls; the decision itself is unchanged.
 * Until the SFE Manager recommends, a check waits on the Place checks board exactly as before.
 *
 * 🔴 ONE RULE FOR BOTH PAGES. The Place checks page takes these rows OUT with `withoutSfeRecommended`, and
 * the SFE recommendations page takes the SAME rows IN with `splitBySfeRecommendation` — so a check is on
 * exactly one of the two, never both and never neither. Pure and screen-free; both server pages import it.
 */

import type { PlaceRecommendation } from "@/lib/phoenix-crm/place-note-rules";
import type { PlaceNoteIndex } from "@/lib/phoenix-crm/view-types";

/** The Super Admin's page of the SFE Manager's recommendations. */
export const SFE_RECOMMENDATIONS_PATH = "/admin/field-crm/sfe-recommendations";

type Recommendations = PlaceNoteIndex["recommendations"];

/** What the SFE Manager recommended on one subject, or null when he has not. The newest row wins. */
export function sfeRecommendationOf(recommendations: Recommendations, subjectKey: string): PlaceRecommendation | null {
  return (recommendations[subjectKey] ?? []).find((row) => row.writerRole === "sfe_manager")?.recommendation ?? null;
}

/** The rows the SFE Manager has not recommended on — what stays on the Super Admin's Place checks board. */
export function withoutSfeRecommended<Row>(rows: ReadonlyArray<Row>, keyOf: (row: Row) => string, recommendations: Recommendations): Row[] {
  return rows.filter((row) => sfeRecommendationOf(recommendations, keyOf(row)) === null);
}

/** The rows the SFE Manager HAS recommended on, split by what he recommended. */
export function splitBySfeRecommendation<Row>(
  rows: ReadonlyArray<Row>,
  keyOf: (row: Row) => string,
  recommendations: Recommendations,
): { validate: Row[]; reject: Row[] } {
  const validate: Row[] = [];
  const reject: Row[] = [];
  for (const row of rows) {
    const said = sfeRecommendationOf(recommendations, keyOf(row));
    if (said === "validate") validate.push(row);
    else if (said === "reject") reject.push(row);
  }
  return { validate, reject };
}
