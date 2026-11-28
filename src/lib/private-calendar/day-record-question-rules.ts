/**
 * The pure half of the day-record questions (`day-record-questions.ts`): which days a product manager is
 * asked about, the words of the question, and how an answer is read. No database, no AI — pinned by
 * tests/private-calendar-day-records.test.ts.
 */

import { validationError } from "@/lib/http/api-errors";
import { isWithinDayRecordWindow, type LineTrainingDaySummary } from "@/lib/private-calendar/day-records";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";

export type DayQuestionDay = {
  date: string;
  /** What the line's people wrote that day (line training), or the rep's note (conference). */
  notes: string[];
  people: number | null;
  /** Pending record id — conference questions only. */
  recordId: string | null;
  /** The AI's suggestion, never a decision: tick this day? null when it did not answer. */
  suggested: boolean | null;
  suggestionReason: string | null;
};

export type DayQuestion = {
  days: DayQuestionDay[];
  hrId: string;
  /** Stable id of the question, so the screen can answer it. */
  id: string;
  kind: "line_training" | "rep_named";
  lineName: string | null;
  name: string;
  /** "Rep name" for a conference question. */
  namedByName: string | null;
  /** The question in his words, built from the facts — never from the AI's text. */
  prompt: string;
};

export type DayQuestionsResult = { aiAnswered: boolean; questions: DayQuestion[] };

function dayLabel(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC", weekday: "short" });
}

/** "Sun 8 Nov, Mon 9 Nov and Tue 10 Nov". Pure. */
export function listDayLabels(dates: readonly string[]): string {
  const labels = dates.map(dayLabel);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The line-training questions, one per person, from facts alone. Pure, so the rule is pinned by a test. */
export function buildLineTrainingQuestions(input: {
  /** Person-days the No Activity engine names (`${hrIdKey}|${date}`). */
  emptyDays: ReadonlySet<string>;
  /** Person-days already holding a day record of any status (`${hrIdKey}|${date}`): asked once, never again. */
  answered: ReadonlySet<string>;
  lineDays: readonly LineTrainingDaySummary[];
  managers: ReadonlyArray<{ hireDate: string | null; hrId: string; lastWorkingDate: string | null; lineCode: string; name: string }>;
}): DayQuestion[] {
  const out: DayQuestion[] = [];
  for (const manager of input.managers) {
    const key = privateCalendarHrIdKey(manager.hrId);
    const days = input.lineDays.filter(
      (day) =>
        day.lineCode === manager.lineCode &&
        isWithinDayRecordWindow(day.date, manager) &&
        input.emptyDays.has(`${key}|${day.date}`) &&
        !input.answered.has(`${key}|${day.date}`),
    );
    if (days.length === 0) continue;
    const lineName = days[0].lineName;
    out.push({
      days: days.map((day) => ({ date: day.date, notes: day.notes, people: day.people, recordId: null, suggested: null, suggestionReason: null })),
      hrId: manager.hrId,
      id: `line_training|${manager.hrId}|${days[0].date}`,
      kind: "line_training",
      lineName,
      name: manager.name,
      namedByName: null,
      prompt: `${lineName} was in training on ${listDayLabels(days.map((day) => day.date))}, and ${manager.name} has no record on ${days.length === 1 ? "that day" : "those days"}. Was ${manager.name} with them? Tick each day ${manager.name} was there.`,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type DayQuestionAnswer =
  | { dates: string[]; hrId: string; kind: "line_training"; ticked: string[]; trainingNote: string | null }
  | { confirm: string[]; decline: string[]; kind: "rep_named" };

/** Parse one answer. Pure. */
export function parseDayQuestionAnswer(raw: unknown): DayQuestionAnswer {
  const body = (raw ?? {}) as Record<string, unknown>;
  const list = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item ?? "").trim()).filter(Boolean))];
  if (body.kind === "line_training") {
    const dates = list(body.dates).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date));
    const ticked = list(body.ticked).filter((date) => dates.includes(date));
    const hrId = String(body.hrId ?? "").trim();
    if (!hrId || dates.length === 0) throw validationError("This question has no days to answer.");
    const note = String(body.trainingNote ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    return { dates, hrId, kind: "line_training", ticked, trainingNote: note || null };
  }
  if (body.kind === "rep_named") {
    const confirm = list(body.confirm);
    const decline = list(body.decline).filter((id) => !confirm.includes(id));
    if (confirm.length + decline.length === 0) throw validationError("This question has no days to answer.");
    return { confirm, decline, kind: "rep_named" };
  }
  throw validationError("Unknown question.");
}
