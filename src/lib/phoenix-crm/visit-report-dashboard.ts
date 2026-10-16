/**
 * Phoenix CRM — the Visit report generator's dashboard: figures worked out from the rows that were read,
 * with no I/O, so the screen and a test see the same thing.
 *
 * Only what was CHOSEN gets a panel: a category with no chosen field draws nothing, and a sparse field
 * (a next step, an objection, a sample) says "recorded on X of Y visits" instead of a bare zero that reads
 * as "nobody did". The tiles are the head every row carries, so they hold nothing a viewer below his sight
 * could not already read in the table.
 *
 * 🔴 NO PANEL RANKS A REP BY A SAVE TIME. The order, the gap and the speed are shown as distributions of
 * how the visits were logged and are never coloured, thresholded or flagged (owner, 2026-10-02).
 */

import { PHOENIX_VISIT_KIND_LABELS } from "@/lib/phoenix-crm/visit-kind-labels";
import type {
  VisitReportCategoryId,
  VisitReportDashboard,
  VisitReportDashboardPanel,
  VisitReportDashboardTile,
  VisitReportField,
  VisitReportRow,
} from "@/lib/phoenix-crm/visit-report-fields";

const FAR = "Far from the place";
const MEASURED = new Set(["At the place", FAR, "Weak signal"]);
const TOP = 10;

function percent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
}

/** The ranked labels of a list of values; the tail beyond `limit` folds into one "Other" bar. */
function tally(values: ReadonlyArray<string>, limit = TOP): Array<{ label: string; value: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length <= limit) return ranked.map(([label, value]) => ({ label, value }));
  const head = ranked.slice(0, limit).map(([label, value]) => ({ label, value }));
  const rest = ranked.slice(limit).reduce((sum, [, value]) => sum + value, 0);
  return [...head, { label: `Other (${ranked.length - limit} more)`, value: rest }];
}

function bucket(value: number, steps: ReadonlyArray<{ upTo: number; label: string }>, last: string): string {
  for (const step of steps) if (value < step.upTo) return step.label;
  return last;
}

function textValues(rows: ReadonlyArray<VisitReportRow>, key: string): string[] {
  return rows.flatMap((row) => {
    const value = row.values[key];
    return typeof value === "string" && value.trim() !== "" ? [value.trim()] : [];
  });
}

function listValues(rows: ReadonlyArray<VisitReportRow>, key: string): string[] {
  return textValues(rows, key).flatMap((value) => value.split(",").map((part) => part.trim()).filter(Boolean));
}

function numberValues(rows: ReadonlyArray<VisitReportRow>, key: string): number[] {
  return rows.flatMap((row) => {
    const value = row.values[key];
    return typeof value === "number" && Number.isFinite(value) ? [value] : [];
  });
}

export function buildVisitReportDashboard(input: {
  rows: ReadonlyArray<VisitReportRow>;
  fields: ReadonlyArray<VisitReportField>;
  days: ReadonlyArray<string>;
  filled: Readonly<Record<string, number>>;
}): VisitReportDashboard {
  const { rows, fields, days, filled } = input;
  const chosen = new Set(fields.map((field) => field.key));
  const total = rows.length;

  const reps = new Set(rows.map((row) => row.repName));
  const repDays = new Set(rows.map((row) => `${row.repName}|${row.visitDate}`));
  const planned = rows.filter((row) => row.planned).length;
  const notSingle = rows.filter((row) => row.visitType !== "" && row.visitType !== PHOENIX_VISIT_KIND_LABELS.single).length;
  const measured = rows.filter((row) => row.locationFlag !== null && MEASURED.has(row.locationFlag));
  const far = measured.filter((row) => row.locationFlag === FAR).length;

  const tiles: VisitReportDashboardTile[] = [
    { label: "Visits", value: total.toLocaleString("en-US"), hint: `${days.length} day${days.length === 1 ? "" : "s"} with visits` },
    {
      label: "Visits per person per working day",
      value: repDays.size === 0 ? "—" : (total / repDays.size).toFixed(1),
      hint: `${reps.size} ${reps.size === 1 ? "person" : "people"}, over the days each logged any visit`,
    },
    { label: "On the plan", value: percent(planned, total), hint: `${planned} of ${total}` },
    { label: "With a manager or product manager", value: percent(notSingle, total), hint: `${notSingle} of ${total}` },
    { label: "Far from the place", value: percent(far, measured.length), hint: `${far} of ${measured.length} measured against a place` },
  ];

  const panels: VisitReportDashboardPanel[] = [];
  const add = (
    id: string,
    category: VisitReportCategoryId,
    title: string,
    kind: "columns" | "bars",
    items: Array<{ label: string; value: number }>,
    note?: string,
  ) => {
    if (items.length > 0) panels.push({ id, category, title, kind, items, ...(note ? { note } : {}) });
  };
  const blankNote = (key: string, counted: number): string | undefined => {
    const field = fields.find((entry) => entry.key === key);
    if (!field) return undefined;
    if (field.sparse) return `Recorded on ${filled[key] ?? counted} of ${total} visits.`;
    return counted < total ? `${total - counted} of ${total} visits have no value.` : undefined;
  };
  const barsOf = (id: string, category: VisitReportCategoryId, title: string, key: string, values: string[], limit = TOP) => {
    if (!chosen.has(key)) return;
    add(id, category, title, "bars", tally(values, limit), blankNote(key, values.length));
  };

  // Always drawn: how the visits fall across the days.
  const perDay = new Map<string, number>();
  for (const row of rows) perDay.set(row.visitDate, (perDay.get(row.visitDate) ?? 0) + 1);
  add(
    "visits-per-day",
    "when",
    "Visits per day",
    "columns",
    [...perDay.entries()].sort((left, right) => left[0].localeCompare(right[0])).map(([label, value]) => ({ label, value })),
  );

  barsOf("visit-type", "when", "Visit type", "visitType", textValues(rows, "visitType"));
  barsOf("planned", "when", "Planned or unplanned", "plannedOrNot", textValues(rows, "plannedOrNot"));
  barsOf("weekday", "when", "Day of the week", "dayOfWeek", textValues(rows, "dayOfWeek"));
  barsOf("entry-route", "when", "How the visit was entered", "entryRoute", textValues(rows, "entryRoute"));

  if (chosen.has("repName") && reps.size > 1) {
    add("per-rep", "org", "Visits per person", "bars", tally(rows.map((row) => row.repName), 12));
  }

  barsOf("list-type", "customer", "AM, PM or pharmacy", "listType", textValues(rows, "listType"));
  barsOf("grade", "customer", "Customer grade", "grade", textValues(rows, "grade"));
  barsOf("speciality", "customer", "Speciality", "speciality", textValues(rows, "speciality"), 8);
  barsOf("customers", "customer", "Most visited customers", "customerName", textValues(rows, "customerName"));
  barsOf("customer-status", "customer", "Customer status", "customerStatus", textValues(rows, "customerStatus"));

  barsOf("bricks", "place", "Bricks visited", "brick", textValues(rows, "brick"));
  barsOf("signboard", "place", "Signboard check", "signboardVerdict", textValues(rows, "signboardVerdict"));
  barsOf("schedule-sign", "place", "Schedule-sign check", "scheduleVerdict", textValues(rows, "scheduleVerdict"));

  barsOf("products-detailed", "content", "Products detailed", "productsDetailed", listValues(rows, "productsDetailed"));
  barsOf("products-missing", "content", "Products missing at the pharmacy", "productsMissing", listValues(rows, "productsMissing"));
  barsOf("objections", "content", "Objections", "objection", textValues(rows, "objection"));
  barsOf("next-steps", "content", "Next steps", "nextStep", textValues(rows, "nextStep"));

  barsOf("location-flag", "location", "Position against the place", "locationFlag", textValues(rows, "locationFlag"));
  if (chosen.has("distanceFromPlace")) {
    const distances = numberValues(rows, "distanceFromPlace");
    const steps = [
      { upTo: 100, label: "Under 100 m" },
      { upTo: 300, label: "100 to 300 m" },
      { upTo: 1000, label: "300 m to 1 km" },
    ];
    const order = ["Under 100 m", "100 to 300 m", "300 m to 1 km", "Over 1 km"];
    const counted = new Map<string, number>();
    for (const distance of distances) {
      const label = bucket(distance, steps, "Over 1 km");
      counted.set(label, (counted.get(label) ?? 0) + 1);
    }
    add(
      "distance-spread",
      "location",
      "Distance from the place",
      "columns",
      order.filter((label) => counted.has(label)).map((label) => ({ label, value: counted.get(label) as number })),
      blankNote("distanceFromPlace", distances.length),
    );
  }
  if (chosen.has("integrityDetectors")) {
    const withCase = textValues(rows, "integrityDetectors").length;
    add(
      "integrity",
      "location",
      "Visits with an integrity case",
      "bars",
      [
        { label: "With a case", value: withCase },
        { label: "Without", value: total - withCase },
      ],
      "A case is a reason to look, never a verdict.",
    );
  }

  barsOf("approval", "approval", "Approval of off-plan visits", "approvalStatus", textValues(rows, "approvalStatus"));
  barsOf("validation", "validation", "Validation of the place", "validationStatus", textValues(rows, "validationStatus"));

  if (chosen.has("plannedThatDay")) {
    const yes = rows.filter((row) => row.values.plannedThatDay === true).length;
    add("planned-that-day", "day", "On the plan for that day", "bars", [
      { label: "On the plan", value: yes },
      { label: "Not on the plan", value: total - yes },
    ]);
  }
  barsOf("day-activity", "day", "Day activity", "dayActivity", textValues(rows, "dayActivity"));

  if (chosen.has("visitsThatDay")) {
    const counts = numberValues(rows, "visitsThatDay");
    const perCount = new Map<number, number>();
    for (const count of counts) perCount.set(count, (perCount.get(count) ?? 0) + 1);
    add(
      "visits-that-day",
      "computed",
      "Visits logged in the day",
      "columns",
      [...perCount.entries()].sort((left, right) => left[0] - right[0]).map(([count, visits]) => ({ label: `${count}`, value: visits })),
      "How many visits the rep saved that day — a picture of how the day is logged, not of how the rep works.",
    );
  }
  if (chosen.has("distanceFromPreviousKm")) {
    const km = numberValues(rows, "distanceFromPreviousKm");
    const steps = [
      { upTo: 1, label: "Under 1 km" },
      { upTo: 3, label: "1 to 3 km" },
      { upTo: 10, label: "3 to 10 km" },
    ];
    const order = ["Under 1 km", "1 to 3 km", "3 to 10 km", "Over 10 km"];
    const counted = new Map<string, number>();
    for (const value of km) {
      const label = bucket(value, steps, "Over 10 km");
      counted.set(label, (counted.get(label) ?? 0) + 1);
    }
    add(
      "distance-previous",
      "computed",
      "Distance from the previous visit",
      "columns",
      order.filter((label) => counted.has(label)).map((label) => ({ label, value: counted.get(label) as number })),
      blankNote("distanceFromPreviousKm", km.length),
    );
  }
  if (chosen.has("daysSinceCustomerVisit")) {
    const since = numberValues(rows, "daysSinceCustomerVisit");
    const steps = [
      { upTo: 8, label: "Within a week" },
      { upTo: 15, label: "1 to 2 weeks" },
      { upTo: 31, label: "2 weeks to a month" },
    ];
    const order = ["Within a week", "1 to 2 weeks", "2 weeks to a month", "Over a month"];
    const counted = new Map<string, number>();
    for (const value of since) {
      const label = bucket(value, steps, "Over a month");
      counted.set(label, (counted.get(label) ?? 0) + 1);
    }
    add(
      "days-since",
      "computed",
      "Time since the customer's last visit",
      "columns",
      order.filter((label) => counted.has(label)).map((label) => ({ label, value: counted.get(label) as number })),
      "Blank when no earlier visit was found in the month before the period.",
    );
  }

  return { tiles, panels };
}
