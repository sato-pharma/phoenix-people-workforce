/**
 * THE QUESTIONS PHOENIX PUTS TO THE SUPER ADMIN — owner, 2026-11-28: *"not every week, all the training
 * manager is responsible. Here comes the role of the AI. He in this situation, he asks the super admin.
 * For example, Line Pedia was training on … Did Dr. Rasha Sabry was in all days … and he gave me the days
 * as MCQ multiple choice … never automatic."*
 *
 * Two kinds of question, both answered day by day with ticks, and NOTHING covers a day until he ticks it:
 *
 *   1. **Line training** — a product manager has no record on days her line was in Training (2+ of its
 *      people logged it in Phoenix CRM). "Pedia was in training on 8–12 Nov — was Dr. Rasha with them?"
 *      A ticked day becomes a `confirmed` day record (`origin = line_training`), an unticked one
 *      `declined`, so a day once answered is never asked again.
 *   2. **A rep named him on a Conference** — a `pending` record; ticked → `confirmed`, unticked → `declined`.
 *
 * The AI (the one shared door, `createOpenAiResponseText`, Anthropic first) reads what the line's people
 * wrote on each training day and SUGGESTS which days look like the whole line together (pre-ticked, with
 * its one-line reason) and which look like one rep's own training. It never writes a record; without a key
 * or on any failure, the questions come with every day unticked and no suggestion.
 *
 * Only a day that is really empty is asked about: the same No Activity engine the deductions use
 * (`getCompanyNoActivityDays`) must name the person on that day.
 */

import { randomUUID } from "node:crypto";

import { createOpenAiResponseText, hasAiApiKey } from "@/lib/ai/openai-client";
import { tryParseAiJson } from "@/lib/ai/parse-ai-json";
import type { AccessContext } from "@/lib/auth/permissions";
import { validationError } from "@/lib/http/api-errors";
import { assertDayRecordActor } from "@/lib/private-calendar/day-records-admin";
import {
  loadLineTrainingDays,
  PRIVATE_CALENDAR_DAY_RECORDS_TABLE,
  type LineTrainingDaySummary,
} from "@/lib/private-calendar/day-records";
import { buildLineTrainingQuestions, listDayLabels, parseDayQuestionAnswer, type DayQuestion, type DayQuestionsResult } from "@/lib/private-calendar/day-record-question-rules";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";
import { getCompanyNoActivityDays } from "@/lib/private-calendar/service";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { hrIdForStorage } from "@/lib/hr-id";
import { getSupabaseAdmin } from "@/lib/supabase/server";

const QUESTIONS_CLAUDE_MODEL = "claude-haiku-5-5";
const QUESTIONS_OPENAI_MODEL = "gpt-5.4-nano";


type Row = Record<string, unknown>;

function displayName(row: Row) {
  return String(row.nickname ?? "").trim() || String(row.full_name ?? "").trim() || "Unnamed employee";
}

const SUGGESTION_FORMAT = {
  format: {
    name: "private_calendar_day_questions",
    schema: {
      additionalProperties: false,
      properties: {
        days: {
          items: {
            additionalProperties: false,
            properties: {
              key: { type: "string" as const },
              whole_line: { type: "boolean" as const },
              reason: { type: "string" as const },
            },
            required: ["key", "whole_line", "reason"],
            type: "object" as const,
          },
          type: "array" as const,
        },
      },
      required: ["days"],
      strict: true as const,
      type: "object" as const,
    },
    strict: true as const,
    type: "json_schema" as const,
  },
};

const SUGGESTION_INSTRUCTIONS = [
  "You help the HR manager of a pharmaceutical company decide whether a line's product manager was with the line's training on a given day.",
  "For each line-day you get how many of the line's people logged Training in their CRM and what they wrote (English or Egyptian Arabic).",
  "Answer whole_line = true when the notes describe one shared training of the line or a large group (e.g. Newcomers training, an office training, a course with a trainer), the kind a product manager normally attends.",
  "Answer whole_line = false when the notes describe a rep's own training in the field (a double visit for training, coaching one rep, a hospital visit) or are too thin to tell.",
  "reason: at most 14 words, plain English, naming what the notes say. Never invent attendance; you only judge what kind of training it was.",
].join(" ");

/** Ask the AI about each line-day. Never throws: no key or any failure answers an empty map. */
async function suggestLineDays(lineDays: readonly LineTrainingDaySummary[]): Promise<Map<string, { reason: string; wholeLine: boolean }>> {
  const out = new Map<string, { reason: string; wholeLine: boolean }>();
  if (lineDays.length === 0 || !hasAiApiKey()) return out;
  const input = lineDays
    .map((day) => `key=${day.lineCode}|${day.date} · line=${day.lineName} · people=${day.people} · notes: ${day.notes.join(" / ") || "(none)"}`)
    .join("\n");
  try {
    const response = await createOpenAiResponseText({
      anthropicModel: QUESTIONS_CLAUDE_MODEL,
      component: "private_calendar_day_questions",
      input,
      instructions: SUGGESTION_INSTRUCTIONS,
      maxOutputTokens: 4000,
      maxRetries: 0,
      model: QUESTIONS_OPENAI_MODEL,
      preferProvider: "anthropic",
      purpose: "private-calendar-day-questions",
      reasoning: { effort: "low" },
      text: SUGGESTION_FORMAT,
      timeoutMs: 45_000,
    });
    const answer = tryParseAiJson(response.outputText) as { days?: Array<{ key?: unknown; reason?: unknown; whole_line?: unknown }> } | null;
    for (const day of answer?.days ?? []) {
      if (typeof day.key !== "string" || typeof day.whole_line !== "boolean") continue;
      out.set(day.key, { reason: String(day.reason ?? "").slice(0, 160), wholeLine: day.whole_line });
    }
  } catch (error) {
    console.error("[private-calendar] the day-question suggestion could not be read", error);
  }
  return out;
}

function monthWindow(year: number, month: number) {
  const key = `${year}-${String(month).padStart(2, "0")}`;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { end: `${key}-${String(last).padStart(2, "0")}`, start: `${key}-01` };
}

export type { DayQuestion, DayQuestionDay, DayQuestionsResult } from "@/lib/private-calendar/day-record-question-rules";

/** Every open question for one month. Super Admin only. */
export async function findDayRecordQuestions(access: AccessContext, input: { month: number; year: number }): Promise<DayQuestionsResult> {
  assertDayRecordActor(access);
  if (!Number.isInteger(input.year) || !Number.isInteger(input.month) || input.month < 1 || input.month > 12) {
    throw validationError("Pick a month.");
  }
  const window = monthWindow(input.year, input.month);
  const supabase = getSupabaseAdmin();
  const [lineTraining, records, emptyDays, managerRows] = await Promise.all([
    loadLineTrainingDays(window),
    fetchAllRows<Row>(
      () =>
        supabase
          .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
          .select("id, employee_hr_id, record_date, status, origin, named_by_hr_id, note")
          .is("voided_at", null)
          .gte("record_date", window.start)
          .lte("record_date", window.end),
      "id",
    ),
    getCompanyNoActivityDays({ access, end: window.end, start: window.start }),
    fetchAllRows<Row>(
      () => supabase.from("employees").select("hr_id, full_name, nickname, job_title, line_id, hire_date, last_working_date").ilike("job_title", "%product manager%"),
      "hr_id",
    ),
  ]);

  const answered = new Set(records.map((row) => `${privateCalendarHrIdKey(String(row.employee_hr_id ?? ""))}|${String(row.record_date).slice(0, 10)}`));
  const empty = new Set(emptyDays.map((day) => `${privateCalendarHrIdKey(day.employeeHrId)}|${day.date}`));
  const productManagerKeys = new Set(lineTraining.days.map((day) => privateCalendarHrIdKey(day.hrId)));
  const lineCodeOf = new Map<string, string>();
  for (const day of lineTraining.days) {
    const summary = lineTraining.lineDays.find((line) => line.date === day.date && line.lineName === day.lineName);
    if (summary) lineCodeOf.set(privateCalendarHrIdKey(day.hrId), summary.lineCode);
  }
  const managers = managerRows
    .filter((row) => productManagerKeys.has(privateCalendarHrIdKey(String(row.hr_id ?? ""))))
    .flatMap((row) => {
      const hrId = String(row.hr_id ?? "").trim();
      const lineCode = lineCodeOf.get(privateCalendarHrIdKey(hrId));
      return lineCode
        ? [{ hireDate: (row.hire_date as string | null) ?? null, hrId, lastWorkingDate: (row.last_working_date as string | null) ?? null, lineCode, name: displayName(row) }]
        : [];
    });

  const questions = buildLineTrainingQuestions({ answered, emptyDays: empty, lineDays: lineTraining.lineDays, managers });

  // The conference questions: every pending record a rep wrote, grouped per person.
  const pending = records.filter((row) => row.status === "pending" && row.origin === "rep_named");
  if (pending.length > 0) {
    const ids = [...new Set(pending.flatMap((row) => [String(row.employee_hr_id ?? ""), String(row.named_by_hr_id ?? "")]).filter(Boolean))];
    const people = await fetchAllRows<Row>(() => supabase.from("employees").select("hr_id, full_name, nickname").in("hr_id", ids), "hr_id");
    const nameOf = new Map(people.map((person) => [privateCalendarHrIdKey(String(person.hr_id ?? "")), displayName(person)]));
    const name = (id: unknown) => nameOf.get(privateCalendarHrIdKey(String(id ?? ""))) ?? "Not an employee";
    const byPersonAndRep = new Map<string, Row[]>();
    for (const row of pending) {
      const key = `${privateCalendarHrIdKey(String(row.employee_hr_id))}|${privateCalendarHrIdKey(String(row.named_by_hr_id))}`;
      byPersonAndRep.set(key, [...(byPersonAndRep.get(key) ?? []), row]);
    }
    for (const rows of byPersonAndRep.values()) {
      const sorted = [...rows].sort((a, b) => String(a.record_date).localeCompare(String(b.record_date)));
      const person = name(sorted[0].employee_hr_id);
      const rep = name(sorted[0].named_by_hr_id);
      questions.push({
        days: sorted.map((row) => ({
          date: String(row.record_date).slice(0, 10),
          notes: row.note ? [String(row.note)] : [],
          people: null,
          recordId: String(row.id),
          suggested: null,
          suggestionReason: null,
        })),
        hrId: String(sorted[0].employee_hr_id),
        id: `rep_named|${String(sorted[0].id)}`,
        kind: "rep_named",
        lineName: null,
        name: person,
        namedByName: rep,
        prompt: `${rep} logged a conference on ${listDayLabels(sorted.map((row) => String(row.record_date).slice(0, 10)))} and names ${person} as there too. Tick each day ${person} was there.`,
      });
    }
  }

  // The AI reads only the line-days a question asks about.
  const askedKeys = new Set<string>();
  for (const question of questions) {
    if (question.kind !== "line_training") continue;
    const lineCode = lineCodeOf.get(privateCalendarHrIdKey(question.hrId));
    for (const day of question.days) askedKeys.add(`${lineCode}|${day.date}`);
  }
  const suggestions = await suggestLineDays(lineTraining.lineDays.filter((day) => askedKeys.has(`${day.lineCode}|${day.date}`)));
  for (const question of questions) {
    if (question.kind !== "line_training") continue;
    const lineCode = lineCodeOf.get(privateCalendarHrIdKey(question.hrId));
    for (const day of question.days) {
      const suggestion = suggestions.get(`${lineCode}|${day.date}`);
      if (!suggestion) continue;
      day.suggested = suggestion.wholeLine;
      day.suggestionReason = suggestion.reason || null;
    }
  }
  return { aiAnswered: suggestions.size > 0, questions };
}

/** Save his ticks: ticked days confirmed, the rest declined. Super Admin only. */
export async function answerDayRecordQuestion(access: Pick<AccessContext, "hrId" | "role">, raw: unknown): Promise<{ confirmed: number; declined: number }> {
  assertDayRecordActor(access);
  const answer = parseDayQuestionAnswer(raw);
  const supabase = getSupabaseAdmin();
  const now = new Date().toISOString();
  if (answer.kind === "rep_named") {
    const decide = async (ids: string[], status: "confirmed" | "declined") => {
      if (ids.length === 0) return 0;
      const { data, error } = await supabase
        .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
        .update({ decided_at: now, decided_by_hr_id: hrIdForStorage(access.hrId), status })
        .in("id", ids)
        .eq("status", "pending")
        .eq("origin", "rep_named")
        .is("voided_at", null)
        .select("id");
      if (error) throw new Error(`Could not save the answer: ${error.message}`);
      return data?.length ?? 0;
    };
    const confirmed = await decide(answer.confirm, "confirmed");
    const declined = await decide(answer.decline, "declined");
    return { confirmed, declined };
  }
  // A day answered once is never written twice.
  const { data: existing, error: existingError } = await supabase
    .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
    .select("record_date")
    .ilike("employee_hr_id", answer.hrId)
    .in("record_date", answer.dates)
    .is("voided_at", null);
  if (existingError) throw new Error(`Could not read the day's records: ${existingError.message}`);
  const taken = new Set(((existing ?? []) as Row[]).map((row) => String(row.record_date).slice(0, 10)));
  const batchId = randomUUID();
  const rows = answer.dates
    .filter((date) => !taken.has(date))
    .map((date) => ({
      activity_type: "training",
      batch_id: batchId,
      decided_at: now,
      decided_by_hr_id: hrIdForStorage(access.hrId),
      employee_hr_id: answer.hrId,
      entered_by_hr_id: hrIdForStorage(access.hrId),
      note: answer.trainingNote,
      origin: "line_training",
      record_date: date,
      status: answer.ticked.includes(date) ? "confirmed" : "declined",
    }));
  if (rows.length > 0) {
    const { error } = await supabase.from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE).insert(rows);
    if (error) throw new Error(`Could not save the answer: ${error.message}`);
  }
  return {
    confirmed: rows.filter((row) => row.status === "confirmed").length,
    declined: rows.filter((row) => row.status === "declined").length,
  };
}
