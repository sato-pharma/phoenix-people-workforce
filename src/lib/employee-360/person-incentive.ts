// Employee 360 — the figures of one person's incentive, cut down from their own Incentive tab's data.
//
// Pure, and the only thing that leaves the server for this section. That data also carries the
// person's base, basic, gross and net salary, which the Incentive tab hides behind its own eye button
// and which this report has no business holding, so the shape below names what may pass and nothing
// else. Nothing here calculates: scheme-2026 stays where it is, and these are the portal's own answers.

import type { MedicalRepPortalData } from "@/lib/employee-portal/service";

export type PersonIncentiveFigures =
  /** A profile that is not linked: the person's own tab has nothing to show either. */
  | { state: "none" }
  /** The published closing a manager is scored on could not be read. Never "No target yet". */
  | { state: "unread" }
  | {
      state: "ready";
      semesterLabel: string | null;
      /** Null while the semester has no target: 0 would read as "achieved nothing". */
      achievementPercent: number | null;
      /** Null with it. The curve pays nothing on no target, which is not the same as earning nothing. */
      incentiveEgp: number | null;
      /** A Pedia seat in a split semester is paid on two achievements; null for everyone else. */
      satoAchievementPercent: number | null;
      /** Names the months when the semester is not fully loaded, so a figure reads as provisional. */
      notice: string | null;
    };

export function personIncentiveFigures(data: MedicalRepPortalData): PersonIncentiveFigures {
  if (data.empty.profile) return { state: "none" };
  if (data.sales.incentiveClosingUnread) return { state: "unread" };

  const hasTarget = data.sales.incentiveSemesterTarget > 0;
  const split = data.sales.pediaSplit;
  return {
    state: "ready",
    semesterLabel: data.sales.incentiveSemesterLabel,
    achievementPercent: hasTarget ? data.sales.overviewAchievementPercent : null,
    incentiveEgp: hasTarget ? data.payroll.incentive : null,
    satoAchievementPercent: split && split.satoTarget > 0 ? split.satoAchievementPercent : null,
    notice: data.sales.incentiveWindowNotice,
  };
}
