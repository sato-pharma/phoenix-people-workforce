import type { ManagerDayPlan, PlanRowOutcome, PlanVsActualRow } from "@/lib/phoenix-crm/manager-day-plan";
import { managerVisitCustomerType, managerVisitHalfLabel, type ManagerDayVisit } from "@/lib/phoenix-crm/manager-visit-detail";

/**
 * Phoenix CRM — what one row of a manager's day table says, decided once (owner, 2026-10-28, on a district manager's
 * day with no sent plan: every double visit said "no plan" four times, the half twice, the customer's type twice, the
 * area twice, "a location was captured" on every row, and its detail line read as a second row under it).
 *
 * 🔴 EVERY FACT IS SAID ONCE. A day with no sent plan says so in ONE note above the table, never a chip and a sentence
 *    on every row; the verdict is a chip in the status column and nowhere else; a chip that repeats a chip beside it
 *    (the half, the plan's kind, "Single visit, alone"), a name the plan already printed, a place the customer's type
 *    already gave and an area the brick line already gave are all left out. Nothing here decides a verdict — that is
 *    `buildPlanVsActual`'s, and the weekly report's under it; this only decides which words a row prints.
 *
 * Pure: no I/O, no React — the table draws it on a server page and a client screen alike, and the tests read it.
 */

function said(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The verdict in a sentence, where the sentence adds something to its chip — a planned row only. */
const STATUS_SENTENCE: Record<PlanRowOutcome, string | null> = {
  ahead: null,
  done: "Matches the plan.",
  no_plan: null,
  not_checkable: "Nothing to check for this half-day.",
  not_done: "Nothing was logged for it.",
  open: "Not due yet, or still open today.",
  unplanned: null,
};

/**
 * The day's "No sent plan covers this day" note: shown ONCE, above the table. A plan that was drawn and not sent shows
 * it, and so does a day with no plan at all whose visits nobody could judge — but never a plan that failed to load
 * (its own warning says so), and never a rep's day, whose every visit answers from his own week.
 */
export function planActualSaysNoPlan(
  plan: Pick<ManagerDayPlan, "sent"> | null,
  planUnread: boolean,
  rows: readonly Pick<PlanVsActualRow, "outcome">[],
): boolean {
  if (plan) return !plan.sent;
  return !planUnread && rows.some((row) => row.outcome === "no_plan");
}

/** Which brick, area and line a visit was at, each once: the territory is `<area> · <line>`, so only its line is new. */
export function managerVisitTerritoryLine(visit: Pick<ManagerDayVisit, "areaName" | "territoryName">): string | null {
  const territory = (visit.territoryName ?? "").trim();
  if (!territory) return null;
  const area = (visit.areaName ?? "").trim();
  if (area && said(territory) === said(area)) return null;
  if (area && said(territory).startsWith(`${said(area)} · `)) {
    const line = territory.split("·").slice(area.split("·").length).join("·").trim();
    return line ? `Line ${line}` : null;
  }
  return `Territory ${territory}`;
}

/** The place's own label ("Al Salam Hospital"), only when the customer's name, type or address has not said it already. */
export function managerVisitPlaceNote(visit: Pick<ManagerDayVisit, "address" | "customerName" | "grade" | "listType" | "placeLabel" | "speciality">): string | null {
  const label = (visit.placeLabel ?? "").trim();
  if (!label) return null;
  const key = said(label);
  return [visit.customerName, managerVisitCustomerType(visit), visit.address].some((text) => said(text).includes(key)) ? null : label;
}

export type PlanActualRowWords = {
  /** The verdict chip. Null on a day with no sent plan (the note says it once) and where a chip beside it says it already. */
  verdict: string | null;
  /** The verdict in a sentence — a planned row only, and never a second "nothing to check" under a "Nothing ticked" chip. */
  sentence: string | null;
  /** The customer seen — null when the plan column already named the very same customer. */
  customerName: string | null;
  /** "PM list", "Pharmacy": only when it says something the row's own half chip does not. */
  listChip: string | null;
  /** Who came along. The plan's own "With <name>" is not printed a second time. */
  withPeople: ManagerDayVisit["withPeople"];
  /** Said when a visit that was not alone names nobody beside him; never "Alone" under "Single visit, alone". */
  withNobody: string | null;
  territoryLine: string | null;
  placeNote: string | null;
  /** Only when NO location was captured — a captured pin is what the address already shows. */
  locationNote: string | null;
};

export function planActualRowWords(row: PlanVsActualRow): PlanActualRowWords {
  const visit = row.actual;
  const besideIt = new Set([row.half, row.plan?.kindLabel, row.plan?.flagLabel].map(said).filter(Boolean));
  const verdict = row.outcome === "no_plan" || besideIt.has(said(row.outcomeLabel)) ? null : row.outcomeLabel;
  const sentence = !row.plan || (row.outcome === "not_checkable" && verdict) ? null : STATUS_SENTENCE[row.outcome];
  if (!visit) {
    return { customerName: null, listChip: null, locationNote: null, placeNote: null, sentence, territoryLine: null, verdict, withNobody: null, withPeople: [] };
  }
  const list = managerVisitHalfLabel(visit);
  const title = said(row.plan?.title);
  const withPeople = visit.withPeople.filter((person) => !(title && said(person.name) && title.includes(said(person.name))));
  return {
    customerName: row.plan?.customerName && said(row.plan.customerName) === said(visit.customerName) ? null : visit.customerName,
    listChip: list === "Pharmacy" || visit.bucket !== row.half ? list : null,
    locationNote: visit.hasPin ? null : "No location captured.",
    placeNote: managerVisitPlaceNote(visit),
    sentence,
    territoryLine: managerVisitTerritoryLine(visit),
    verdict,
    withNobody: visit.withPeople.length === 0 && visit.kind !== "single" ? "No one else named." : null,
    withPeople,
  };
}
