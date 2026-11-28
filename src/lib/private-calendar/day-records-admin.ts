/**
 * THE SUPER ADMIN RECORDS ONE DAY FOR A GROUP, IN ONE STEP (owner, 2026-11-28): *"make an option for the
 * system administrator to pick the people, but group them and make able to multi-tick and, for example,
 * select all district managers and exclude one … and enter the daily record for this day. For example,
 * we all had a meeting on Thursday. The managers did not submit it by default. Okay, I can submit it for
 * them all by one step."*
 *
 * Super Admin only, end to end (`assertDayRecordActor`). Each save writes one row per person, all
 * sharing one batch, into `private_calendar_day_records`; the rule that reads them is `day-records.ts`.
 * A person is SKIPPED, and told back by name, when the day is outside his employment window or he
 * already holds a standing day record for it — never two records for one day. A record is voided,
 * never deleted.
 */

import { randomUUID } from "node:crypto";

import type { AccessContext } from "@/lib/auth/permissions";
import { forbiddenError, validationError } from "@/lib/http/api-errors";
import {
  DAY_RECORD_ACTIVITY_LABELS,
  isDayRecordActivity,
  isWithinDayRecordWindow,
  PRIVATE_CALENDAR_DAY_RECORDS_TABLE,
  type DayRecordActivity,
} from "@/lib/private-calendar/day-records";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { hrIdForStorage } from "@/lib/hr-id";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** At most this many people in one step — the whole company fits, a runaway payload does not. */
export const DAY_RECORD_MAX_PEOPLE = 400;

export function assertDayRecordActor(access: Pick<AccessContext, "role">) {
  if (access.role !== "Super Admin") throw forbiddenError("Only the Super Admin records a day for other people.");
}

export type DayRecordPickerPerson = {
  hireDate: string | null;
  hrId: string;
  jobTitle: string;
  lastWorkingDate: string | null;
  lineName: string | null;
  name: string;
};

export type DayRecordPickerGroup = { label: string; people: DayRecordPickerPerson[] };

/** People grouped by job title, groups and people in name order. Pure, so the grouping is pinned. */
export function groupDayRecordPeople(people: readonly DayRecordPickerPerson[]): DayRecordPickerGroup[] {
  const byTitle = new Map<string, DayRecordPickerPerson[]>();
  for (const person of people) {
    const label = person.jobTitle.trim() || "No job title";
    const list = byTitle.get(label) ?? [];
    list.push(person);
    byTitle.set(label, list);
  }
  return [...byTitle.entries()]
    .map(([label, list]) => ({ label, people: [...list].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

type Row = Record<string, unknown>;

function displayName(row: Row) {
  return String(row.nickname ?? "").trim() || String(row.full_name ?? "").trim() || "Unnamed employee";
}

/** Everyone still employed (or on notice), grouped by job title, for the picker. */
export async function loadDayRecordPicker(access: Pick<AccessContext, "role">): Promise<DayRecordPickerGroup[]> {
  assertDayRecordActor(access);
  const [employees, lines] = await Promise.all([
    fetchAllRows<Row>(
      () =>
        getSupabaseAdmin()
          .from("employees")
          .select("hr_id, full_name, nickname, job_title, line_id, hire_date, last_working_date, employment_status"),
      "hr_id",
    ),
    loadReferenceLines(),
  ]);
  const lineName = new Map(lines.map((line) => [String(line.id), String(line.name ?? "")]));
  const today = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
  const people: DayRecordPickerPerson[] = [];
  for (const row of employees) {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId) continue;
    const status = String(row.employment_status ?? "").toLowerCase();
    const lastWorkingDate = (row.last_working_date as string | null) ?? null;
    // Active, or departed less than ~2 months ago (a day of his notice can still be recorded).
    if (status !== "active" && !(lastWorkingDate && lastWorkingDate >= shiftDays(today, -62))) continue;
    people.push({
      hireDate: (row.hire_date as string | null) ?? null,
      hrId,
      jobTitle: String(row.job_title ?? ""),
      lastWorkingDate,
      lineName: lineName.get(String(row.line_id ?? "")) || null,
      name: displayName(row),
    });
  }
  return groupDayRecordPeople(people);
}

function shiftDays(iso: string, days: number) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export type DayRecordDraft = { activityType: DayRecordActivity; date: string; hrIds: string[]; note: string | null };

/** Parse the save's body. Pure. The date may be any past or today's Cairo day, never a future one. */
export function parseDayRecordDraft(raw: unknown, today: string): DayRecordDraft {
  const body = (raw ?? {}) as Record<string, unknown>;
  const date = String(body.date ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw validationError("Pick the day.");
  if (date > today) throw validationError("A day record is for a day that has happened — pick today or an earlier day.");
  if (!isDayRecordActivity(body.activityType)) throw validationError("Pick what the day was.");
  const note = String(body.note ?? "").replace(/\s+/g, " ").trim();
  if (note.length > 500) throw validationError("Keep the note under 500 characters.");
  const hrIds = [...new Set((Array.isArray(body.hrIds) ? body.hrIds : []).map((id) => String(id ?? "").trim()).filter(Boolean))];
  if (hrIds.length === 0) throw validationError("Tick at least one person.");
  if (hrIds.length > DAY_RECORD_MAX_PEOPLE) throw validationError(`At most ${DAY_RECORD_MAX_PEOPLE} people in one step.`);
  return { activityType: body.activityType, date, hrIds, note: note || null };
}

export type DayRecordSaveResult = {
  recorded: Array<{ hrId: string; name: string }>;
  skipped: Array<{ hrId: string; name: string; reason: string }>;
};

/** Who is written and who is skipped, and why. Pure, so the two refusals are pinned by a test. */
export function planDayRecordSave(input: {
  date: string;
  existingKeys: ReadonlySet<string>;
  hrIds: readonly string[];
  people: ReadonlyMap<string, { hireDate: string | null; hrId: string; lastWorkingDate: string | null; name: string }>;
}): { skipped: DayRecordSaveResult["skipped"]; write: Array<{ hrId: string; name: string }> } {
  const write: Array<{ hrId: string; name: string }> = [];
  const skipped: DayRecordSaveResult["skipped"] = [];
  for (const asked of input.hrIds) {
    const person = input.people.get(privateCalendarHrIdKey(asked));
    if (!person) {
      skipped.push({ hrId: asked, name: asked, reason: "Not an employee" });
      continue;
    }
    if (!isWithinDayRecordWindow(input.date, person)) {
      const hired = person.hireDate && input.date < person.hireDate;
      skipped.push({ hrId: person.hrId, name: person.name, reason: hired ? "Not hired yet on that day" : "Had already left on that day" });
      continue;
    }
    if (input.existingKeys.has(privateCalendarHrIdKey(person.hrId))) {
      skipped.push({ hrId: person.hrId, name: person.name, reason: "Already has a day record for that day" });
      continue;
    }
    write.push({ hrId: person.hrId, name: person.name });
  }
  return { skipped, write };
}

export async function recordDayForPeople(access: Pick<AccessContext, "hrId" | "role">, raw: unknown): Promise<DayRecordSaveResult> {
  assertDayRecordActor(access);
  const today = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
  const draft = parseDayRecordDraft(raw, today);
  const supabase = getSupabaseAdmin();
  const [{ data: employees, error: employeeError }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from("employees").select("hr_id, full_name, nickname, hire_date, last_working_date").in("hr_id", draft.hrIds),
    supabase.from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE).select("employee_hr_id").eq("record_date", draft.date).eq("status", "confirmed").is("voided_at", null),
  ]);
  if (employeeError) throw new Error(`Could not read the people: ${employeeError.message}`);
  if (existingError) throw new Error(`Could not read the day's records: ${existingError.message}`);
  const people = new Map<string, { hireDate: string | null; hrId: string; lastWorkingDate: string | null; name: string }>();
  for (const row of (employees ?? []) as Row[]) {
    const hrId = String(row.hr_id ?? "").trim();
    if (!hrId) continue;
    people.set(privateCalendarHrIdKey(hrId), {
      hireDate: (row.hire_date as string | null) ?? null,
      hrId,
      lastWorkingDate: (row.last_working_date as string | null) ?? null,
      name: displayName(row),
    });
  }
  const existingKeys = new Set(((existing ?? []) as Row[]).map((row) => privateCalendarHrIdKey(String(row.employee_hr_id ?? ""))));
  const plan = planDayRecordSave({ date: draft.date, existingKeys, hrIds: draft.hrIds, people });
  if (plan.write.length > 0) {
    const batchId = randomUUID();
    const { error } = await supabase.from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE).insert(
      plan.write.map((person) => ({
        activity_type: draft.activityType,
        batch_id: batchId,
        employee_hr_id: person.hrId,
        entered_by_hr_id: hrIdForStorage(access.hrId),
        note: draft.note,
        origin: "super_admin",
        record_date: draft.date,
        // His own entry is his decision: confirmed on save.
        status: "confirmed",
        decided_at: new Date().toISOString(),
        decided_by_hr_id: hrIdForStorage(access.hrId),
      })),
    );
    if (error) throw new Error(`Could not save the day records: ${error.message}`);
  }
  return { recorded: plan.write, skipped: plan.skipped };
}

export type DayRecordListRow = {
  activityLabel: string;
  date: string;
  enteredBy: string;
  hrId: string;
  id: string;
  name: string;
  note: string | null;
  origin: "line_training" | "rep_named" | "super_admin";
};

/** The standing day records of one month, newest day first, with names. */
export async function listDayRecords(access: Pick<AccessContext, "role">, window: { end: string; start: string }): Promise<DayRecordListRow[]> {
  assertDayRecordActor(access);
  const rows = await fetchAllRows<Row>(
    () =>
      getSupabaseAdmin()
        .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
        .select("id, employee_hr_id, record_date, activity_type, note, origin, entered_by_hr_id, named_by_hr_id")
        .eq("status", "confirmed")
        .is("voided_at", null)
        .gte("record_date", window.start)
        .lte("record_date", window.end),
    "id",
  );
  const ids = [...new Set(rows.flatMap((row) => [row.employee_hr_id, row.entered_by_hr_id, row.named_by_hr_id].map((id) => String(id ?? "").trim()).filter(Boolean)))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const people = await fetchAllRows<Row>(() => getSupabaseAdmin().from("employees").select("hr_id, full_name, nickname").in("hr_id", ids), "hr_id");
    for (const person of people) names.set(privateCalendarHrIdKey(String(person.hr_id ?? "")), displayName(person));
  }
  const nameOf = (id: unknown) => names.get(privateCalendarHrIdKey(String(id ?? ""))) ?? "Not an employee";
  return rows
    .filter((row) => isDayRecordActivity(row.activity_type))
    .map((row) => ({
      activityLabel: DAY_RECORD_ACTIVITY_LABELS[row.activity_type as DayRecordActivity],
      date: String(row.record_date).slice(0, 10),
      enteredBy:
        row.origin === "rep_named"
          ? `Named by ${nameOf(row.named_by_hr_id)}, confirmed`
          : row.origin === "line_training"
            ? "With the line's training, confirmed"
            : `Recorded by ${nameOf(row.entered_by_hr_id)}`,
      hrId: String(row.employee_hr_id),
      id: String(row.id),
      name: nameOf(row.employee_hr_id),
      note: (row.note as string | null) ?? null,
      origin: row.origin === "rep_named" || row.origin === "line_training" ? (row.origin as "line_training" | "rep_named") : ("super_admin" as const),
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

/** Void one record (it stays in the table, no longer covering the day). */
export async function voidDayRecord(access: Pick<AccessContext, "hrId" | "role">, id: string): Promise<void> {
  assertDayRecordActor(access);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw validationError("Unknown day record.");
  const { data, error } = await getSupabaseAdmin()
    .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
    .update({ voided_at: new Date().toISOString(), voided_by_hr_id: hrIdForStorage(access.hrId) })
    .eq("id", id)
    .is("voided_at", null)
    .select("id");
  if (error) throw new Error(`Could not remove the day record: ${error.message}`);
  if (!data || data.length === 0) throw validationError("That day record was already removed.");
}
