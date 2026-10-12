import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";
import { getPrivateCalendarDayEvidence, type PrivateCalendarDayEvidence } from "@/lib/private-calendar/service";

import { dayLabel } from "./text.ts";
import type { DisputeCaseFact } from "./types.ts";

// WHAT PHOENIX HOLDS FOR THE DAYS A DISPUTE IS ABOUT — the one reader all three kinds share.
//
// A calendar dispute, a fingerprint deduction and a weekly-review day are all, underneath, an argument
// about what one employee did on one or more days. The private calendar already gathers every source
// for a day in one place (fingerprint, vacations, excuses, double visits, field visits, the approved
// plan, national holidays), with the field-visit suppression the calendar itself applies. Reading it
// here means the reviewer — and the Case Briefing — see the same record the employee sees on their
// own calendar, never a second, differently-filtered copy.
//
// Nothing here judges. It lists the record beside the claim; the decision stays the reviewer's.

const MAX_DAYS = 31;

export type DayEvidenceResult = {
  facts: DisputeCaseFact[];
  /** Some source could not be read, so a missing item is "unknown", never "did not happen". */
  incomplete: boolean;
};

/** The employee's role and reporting line, as facts. Best-effort: a missing row adds nothing. */
export async function loadEmployeeProfileFacts(employeeHrId: string): Promise<DisputeCaseFact[]> {
  const directory = await getEmployeeDirectoryRows().catch(() => []);
  const key = privateCalendarHrIdKey(employeeHrId);
  const row = directory.find((employee) => privateCalendarHrIdKey(employee.hrId) === key);
  if (!row) return [];
  const facts: DisputeCaseFact[] = [];
  if (row.jobTitle) facts.push({ label: "Job title", value: row.jobTitle });
  if (row.lineName) facts.push({ label: "Line", value: row.lineName });
  if (row.areaName) facts.push({ label: "Area", value: row.areaName });
  if (row.managerName) facts.push({ label: "Manager", value: row.managerName });
  return facts;
}

/**
 * Every calendar item Phoenix holds for `employeeHrId` on each of `dates`, one fact per item, plus a
 * fact saying so when a day holds nothing at all. Dates beyond the first 31 are not read (a dispute
 * about more days than a month is not a dispute about specific days) and that is said too.
 */
export async function loadDayFacts(employeeHrId: string, dates: readonly string[]): Promise<DayEvidenceResult> {
  const wanted = Array.from(new Set(dates.filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)))).sort();
  if (!employeeHrId || wanted.length === 0) return { facts: [], incomplete: false };
  const read = wanted.slice(0, MAX_DAYS);

  let evidence: Map<string, PrivateCalendarDayEvidence>;
  try {
    evidence = await getPrivateCalendarDayEvidence(read.map((date) => ({ date, employeeHrId })));
  } catch {
    return {
      facts: [{ label: "Calendar record", tone: "warning", value: "The calendar record for these days could not be read." }],
      incomplete: true,
    };
  }

  const facts: DisputeCaseFact[] = [];
  let incomplete = false;
  const key = privateCalendarHrIdKey(employeeHrId);
  for (const date of read) {
    const day = evidence.get(`${key}|${date}`) ?? null;
    if (!day) {
      incomplete = true;
      facts.push({ label: dayLabel(date), tone: "warning", value: "The calendar record for this day could not be read." });
      continue;
    }
    if (day.unreadableSources.length > 0) {
      incomplete = true;
      facts.push({
        label: dayLabel(date),
        tone: "warning",
        value: `Could not read: ${day.unreadableSources.join(", ")}. Anything from those sources is unknown, not absent.`,
      });
    }
    if (day.items.length === 0) {
      facts.push({ label: dayLabel(date), value: "Phoenix holds nothing for this day in any calendar source." });
      continue;
    }
    for (const item of day.items) {
      const detail = item.detailLines[0] ?? item.description ?? null;
      const parts = [item.title, detail].filter((part): part is string => Boolean(part && String(part).trim()));
      facts.push({
        label: [dayLabel(date), item.sourceLabel, item.time].filter(Boolean).join(" · "),
        // An approved plan was toned "success" here until 2026-10-12, which read as "this day is
        // settled". It is not: the plan is the intention, and the day is judged on its records.
        tone: item.severity,
        value: parts.join(" — ") || item.sourceLabel,
      });
    }
  }
  if (wanted.length > read.length) {
    facts.push({
      label: "Calendar record",
      tone: "info",
      value: `Only the first ${read.length} of ${wanted.length} days were read.`,
    });
  }
  return { facts, incomplete };
}
