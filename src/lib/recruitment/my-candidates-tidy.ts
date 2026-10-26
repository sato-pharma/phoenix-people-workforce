// Recruitment — three small tidy-ups on the manager's "My Candidates" page (owner, 2026-10-26).
//
// All pure, so the page, its admin twin and the tests read the same rules:
//   • a HIRED candidate is never shown the amber "Applying for · Missing" chip — the role is the seat
//     they were hired into, so a missing answer there is not a gap anyone can or should fill;
//   • a position is named by its role and its area, never by the request code behind it;
//   • "Your team's candidates" hides a manager who has left AND holds no CV, and lists those who hold
//     CVs first.

import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import type { WorkspaceAnswerChip } from "@/lib/recruitment/workspace/types";

/** The chip key `answerChipsFor` gives the "Applying for" answer. */
const ROLE_CHIP_KEY = "role";

/**
 * The chips to show for one candidate. A hired candidate loses ONLY the unanswered role chip; an
 * answered one stays, and a candidate still in the pipeline keeps every chip (missing included).
 */
export function chipsForCandidateStatus(
  status: string | null | undefined,
  chips: readonly WorkspaceAnswerChip[],
): WorkspaceAnswerChip[] {
  if (normalizeCandidateStatus(status?.trim().toLowerCase()) !== "hired") return [...chips];
  return chips.filter((chip) => !(chip.key === ROLE_CHIP_KEY && chip.value === null));
}

/** Area and line names by id, read on the server so the browser never shows a number. */
export type RequisitionPlaces = {
  areas: Record<string, string>;
  lines: Record<string, string>;
};

export const NO_REQUISITION_PLACES: RequisitionPlaces = { areas: {}, lines: {} };

/**
 * "District Sales Manager · Minia 1": the role, then where the seat is. The area when the seat has
 * one; a district seat is region-scoped and has none, so its line stands in. With neither, the role
 * alone. The request code is never part of it.
 */
export function requisitionRoleLabel(
  requisition: { jobTitle: string | null; areaId: number | null; lineId: number | null },
  places: RequisitionPlaces = NO_REQUISITION_PLACES,
): string {
  const role = requisition.jobTitle?.trim() || "";
  const area = requisition.areaId === null ? "" : places.areas[String(requisition.areaId)]?.trim() || "";
  const line = requisition.lineId === null ? "" : places.lines[String(requisition.lineId)]?.trim() || "";
  return [role, area || line].filter(Boolean).join(" · ") || "Position not named";
}

/**
 * The managers to list under "Your team's candidates". One who has left the company and holds no CV
 * has nothing to read, so they are hidden; one who has left but still holds CVs stays. Managers
 * holding CVs come first, and the order is otherwise the one given.
 */
export function tidyTeamManagers<T extends { active: boolean; cvCount: number }>(managers: readonly T[]): T[] {
  const shown = managers.filter((manager) => manager.active || manager.cvCount > 0);
  return [...shown.filter((manager) => manager.cvCount > 0), ...shown.filter((manager) => manager.cvCount <= 0)];
}
