// Employee 360 — which report sections render for a subject's role.
//
// Pure and dependency-free (one type import), so the report view and its tests share one answer.
// Every role family keeps the composition it had; the Regional Manager is the one family whose report
// drops a section that has nothing to show (owner, 2026-10-20: "bring him back but do not show empty
// data, tailor the report on him"). A regional manager's report is his region: the team sales
// roll-up, the coaching and double-visits he delivers, his team's development and compliance, and his
// own field visits and expenses — each one only when it carries data. The rep-only sections (GPS
// check-ins, campaign mix, coaching received, own sales, bricks) never render for him.

import type { Employee360RoleCategory } from "@/lib/employee-360/roles";

/** What the loaded profile holds, as far as the section plan needs to know. */
export type Employee360SectionSignals = {
  /** Productive (regular + campaign) visits the subject logged himself in the window. */
  productiveVisits: number;
  /** Visits logged with a manager alongside the subject. */
  doublesReceived: number;
  /** The leadership activity (coaching authored, double-visits conducted) has rows. */
  leadershipHasData: boolean;
  /** The sales roll-up has validated sales. */
  salesHasData: boolean;
  /** The payroll trips or the outstation records have rows in the window. */
  expensesHaveData: boolean;
};

export type Employee360SectionPlan = {
  /** Anyone but a Medical Rep: leads with what they deliver. */
  isLeader: boolean;
  /** The report hides a manager section that has nothing to show (the Regional Manager). */
  hidesEmptySections: boolean;
  /** Period-over-period strip of the subject's own field work. */
  showComparison: boolean;
  /** Leadership Activity: coaching authored and double-visits conducted. */
  showLeadership: boolean;
  /** The team sales roll-up near the top of a leader's report. */
  showTeamSales: boolean;
  /** The subject's own visits card (Visits & Coverage for a rep, Own Field Presence for a leader). */
  showOwnVisits: boolean;
  /** The "Doubles received" tile and line inside the own-visits card. */
  showDoublesReceived: boolean;
  /** Campaign vs Regular. */
  showCampaign: boolean;
  /** GPS check-in chip and Check-in Timing & Authenticity. */
  showCheckin: boolean;
  /** Coaching, impact and double-visits RECEIVED. */
  showReceivedSide: boolean;
  /** A rep's own sales card further down the report. */
  showOwnSales: boolean;
  /** A rep's bricks against his current list. */
  showBricks: boolean;
  /** Expenses & Outstation, given the page already allows the section for this role. */
  showExpenses: boolean;
};

/** The role families whose report drops a section with nothing to show (owner, 2026-10-20). */
const HIDES_EMPTY_SECTIONS = new Set<Employee360RoleCategory>(["regional-manager"]);

export function planEmployee360Sections(
  category: Employee360RoleCategory,
  signals: Employee360SectionSignals,
  /** The page's own expense gate (a manager-only allow-list by job title). */
  expensesAllowed: boolean,
): Employee360SectionPlan {
  const isLeader = category !== "medical-rep";
  const isRep = category === "medical-rep";
  const hidesEmptySections = HIDES_EMPTY_SECTIONS.has(category);
  return {
    isLeader,
    hidesEmptySections,
    showComparison: isRep,
    showLeadership: isLeader && (!hidesEmptySections || signals.leadershipHasData),
    showTeamSales: isLeader && category !== "training-manager" && (!hidesEmptySections || signals.salesHasData),
    showOwnVisits: !hidesEmptySections || signals.productiveVisits > 0,
    showDoublesReceived: !hidesEmptySections || signals.doublesReceived > 0,
    // Only Medical Reps and Product Managers run campaign calls of their own.
    showCampaign: isRep || category === "product-manager",
    // Only Medical Reps submit their own regular visits, so only they log GPS check-ins; a manager
    // joins the field through double-visits (Leadership Activity).
    showCheckin: isRep,
    showReceivedSide: isRep,
    showOwnSales: isRep,
    showBricks: isRep,
    showExpenses: expensesAllowed && (!hidesEmptySections || signals.expensesHaveData),
  };
}
