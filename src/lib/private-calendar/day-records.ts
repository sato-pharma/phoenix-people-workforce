/**
 * DAY RECORDS — a working day recorded FOR a person who has no record of his own that day.
 *
 * Owner, 2026-11-28, after a Group Product Manager was charged eight "No records" days on which her line
 * was in training: *"these activities must be synchronized in her private calendar and not shows as
 * deductions for now and for upcomings"*, then, asked which activities and who:
 *
 *   - **Training, yes; meetings, no — and NEVER AUTOMATIC** (his correction the same day: "not every
 *     week … here comes the role of the AI … he asks the super admin … gave me the days as MCQ … never
 *     automatic"). A line's Training day — {@link LINE_TRAINING_MIN_PEOPLE}+ of its people logged Training
 *     in Phoenix CRM — is only a QUESTION (`day-record-questions.ts`): "Pedia was in training on these
 *     days — was Dr. Rasha with them?", each day a tick. A ticked day is a `confirmed` record
 *     (`origin = line_training`); an unticked one `declined`, so it is never asked again.
 *   - **Conference: ask the rep.** A rep logging a whole-day Conference names who from the line was with
 *     him; each named person gets a `pending` record (`origin = rep_named`) that covers nothing until
 *     the Super Admin confirms it.
 *   - **The Super Admin records it for a group in one step** — "we all had a meeting on Thursday": every
 *     District Sales Manager but one, ticked from groups (`origin = super_admin`, confirmed on save).
 *
 * ONLY A CONFIRMED, UNVOIDED RECORD COVERS A DAY.
 *
 * Every day record is a WHOLE day, and only ever inside the person's employment window (hire date to
 * last working date) — a training before someone was hired covers nothing (owner, the same day, about a
 * Senior Product Manager hired on 1 December: "check the hiring date").
 *
 * Read in two places, from ONE rule, so the calendar and the deductions can never disagree:
 *   1. the Private Calendar — an entry on the day (`mapDayRecordToPrivateCalendarItem`) that covers it;
 *   2. `loadProvenWorkedDays` — the day is proven worked, so every deduction connector drops it.
 *
 * The deduction read FAILS CLOSED (throws); the calendar read is best-effort like every calendar source.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { privateCalendarHrIdKey, privateCalendarSourceLabels, type PrivateCalendarItem } from "@/lib/private-calendar/logic";
import { fetchAllRows, fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const PRIVATE_CALENDAR_DAY_RECORDS_TABLE = "private_calendar_day_records";

/** How many of a line's people must log Training on one day for it to be the line's training day. */
export const LINE_TRAINING_MIN_PEOPLE = 2;

/** What the Super Admin can record for a group (the table's CHECK holds the same list). */
export const DAY_RECORD_ACTIVITIES = ["meeting", "training", "conference", "group_meeting", "admin_work", "travel", "other"] as const;
export type DayRecordActivity = (typeof DAY_RECORD_ACTIVITIES)[number];

export const DAY_RECORD_ACTIVITY_LABELS: Record<DayRecordActivity, string> = {
  admin_work: "Admin work",
  conference: "Conference",
  group_meeting: "Group meeting",
  meeting: "Meeting",
  other: "Other",
  training: "Training",
  travel: "Travel",
};

export function isDayRecordActivity(value: unknown): value is DayRecordActivity {
  return typeof value === "string" && (DAY_RECORD_ACTIVITIES as readonly string[]).includes(value);
}

export type DayRecordOrigin = "line_training" | "rep_named" | "super_admin";
export type DayRecordStatus = "confirmed" | "declined" | "pending";

export type DayRecord = {
  activityType: DayRecordActivity;
  date: string;
  hrId: string;
  /** Stored record id; null for a line training day, which is read live. */
  id: string | null;
  /** The line's name, for a line training day. */
  lineName: string | null;
  note: string | null;
  origin: DayRecordOrigin;
  /** Who entered it (stored records) — the Super Admin, or the rep who named him. */
  enteredByHrId: string | null;
  namedByHrId: string | null;
  /** The named-by rep's name (nickname, else full name), read with the record — never an id on a screen. */
  namedByName: string | null;
  /** How many of the line's people logged the training (line training days). */
  people: number | null;
};

/** A product manager of a line — the seatless people of the line a line's training day covers. */
export function isLineProductManagerTitle(jobTitle: string | null | undefined): boolean {
  return /product\s+manager/i.test(String(jobTitle ?? ""));
}

/** Inside hire date .. last working date; either bound may be missing. Pure. */
export function isWithinDayRecordWindow(date: string, person: { hireDate: string | null; lastWorkingDate: string | null }): boolean {
  const hire = String(person.hireDate ?? "").slice(0, 10);
  const last = String(person.lastWorkingDate ?? "").slice(0, 10);
  if (hire && date < hire) return false;
  if (last && date > last) return false;
  return true;
}

function isIsoDay(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export type LineTrainingActivityRow = { activity_date: string; activity_type: string; line_code: string | null; rep_hr_id: string | null };
export type LineProductManager = { hireDate: string | null; hrId: string; lastWorkingDate: string | null; lineCode: string };

/**
 * The line training days, one per product manager per day. Pure, so the rule is pinned by a test:
 * Training only, {@link LINE_TRAINING_MIN_PEOPLE}+ distinct people of the line that day, the manager
 * employed that day.
 */
export function selectLineTrainingDays(input: {
  activities: readonly LineTrainingActivityRow[];
  managers: readonly LineProductManager[];
  lineNames: ReadonlyMap<string, string>;
  window: { end: string; start: string };
}): DayRecord[] {
  const peopleByLineDay = new Map<string, Set<string>>();
  for (const row of input.activities) {
    if (row.activity_type !== "training") continue;
    const date = String(row.activity_date ?? "").slice(0, 10);
    const line = String(row.line_code ?? "").trim();
    const person = privateCalendarHrIdKey(String(row.rep_hr_id ?? ""));
    if (!isIsoDay(date) || !line || !person || date < input.window.start || date > input.window.end) continue;
    const key = `${line}|${date}`;
    const set = peopleByLineDay.get(key) ?? new Set<string>();
    set.add(person);
    peopleByLineDay.set(key, set);
  }
  const out: DayRecord[] = [];
  for (const [key, people] of peopleByLineDay) {
    if (people.size < LINE_TRAINING_MIN_PEOPLE) continue;
    const [line, date] = key.split("|");
    for (const manager of input.managers) {
      if (manager.lineCode !== line) continue;
      if (!isWithinDayRecordWindow(date, manager)) continue;
      out.push({
        activityType: "training",
        date,
        enteredByHrId: null,
        hrId: manager.hrId,
        id: null,
        lineName: input.lineNames.get(line) ?? line,
        namedByHrId: null,
        namedByName: null,
        note: null,
        origin: "line_training",
        people: people.size,
      });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.hrId.localeCompare(b.hrId));
}

export type StoredDayRecordRow = {
  activity_type: string;
  employee_hr_id: string;
  entered_by_hr_id: string | null;
  id: string;
  named_by_hr_id: string | null;
  note: string | null;
  origin: string;
  record_date: string;
  status?: string | null;
  voided_at?: string | null;
};

/** Stored records that COVER a day — confirmed, not voided, inside the window. Pure. */
export function selectStoredDayRecords(rows: readonly StoredDayRecordRow[], window: { end: string; start: string }): DayRecord[] {
  const out: DayRecord[] = [];
  for (const row of rows) {
    if (row.voided_at) continue;
    if (row.status !== "confirmed") continue;
    const date = String(row.record_date ?? "").slice(0, 10);
    if (!isIsoDay(date) || date < window.start || date > window.end) continue;
    if (!row.employee_hr_id || !isDayRecordActivity(row.activity_type)) continue;
    if (row.origin !== "super_admin" && row.origin !== "rep_named" && row.origin !== "line_training") continue;
    out.push({
      activityType: row.activity_type,
      date,
      enteredByHrId: row.entered_by_hr_id ?? null,
      hrId: row.employee_hr_id,
      id: row.id,
      lineName: null,
      namedByHrId: row.named_by_hr_id ?? null,
      namedByName: null,
      note: row.note?.trim() || null,
      origin: row.origin,
      people: null,
    });
  }
  return out;
}

/** The reason line a spared day carries into a deduction's evidence. Names never come from memory: ids are resolved by the caller's screen. */
export function describeDayRecord(day: DayRecord): string {
  const label = DAY_RECORD_ACTIVITY_LABELS[day.activityType];
  if (day.origin === "line_training") return `Training — confirmed by the Super Admin${day.note ? `: ${day.note}` : ""}`;
  if (day.origin === "rep_named") return `${label} — named by ${day.namedByName ?? "the rep who logged it"} on the Conference day`;
  return `${label} — recorded by the Super Admin${day.note ? `: ${day.note}` : ""}`;
}

/** One day record as a calendar item that covers the day. Pure. */
export function mapDayRecordToPrivateCalendarItem(day: DayRecord): PrivateCalendarItem {
  const label = DAY_RECORD_ACTIVITY_LABELS[day.activityType];
  const title = label;
  const how =
    day.origin === "line_training"
      ? "With the line's training, confirmed"
      : day.origin === "rep_named"
        ? `Named by ${day.namedByName ?? "the rep who logged it"}, confirmed`
        : "Recorded by the Super Admin";
  const detailLines = [describeDayRecord(day)];
  if (day.note && day.origin === "rep_named") detailLines.push(`Note: ${day.note}`);
  return {
    activityKind: "day_record",
    approvalImpact: "A day record covers this day: it is not a No records deduction.",
    chipLines: [title, how],
    description: day.note,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: day.hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: day.date,
    exceptionFlags: [],
    id: `day-record-${day.origin}-${day.id ?? "live"}-${privateCalendarHrIdKey(day.hrId)}-${day.date}`,
    managerName: null,
    severity: "success",
    source: "day_record",
    sourceLabel: privateCalendarSourceLabels.day_record,
    sourceRecordId: day.id,
    sourceSystem: "Private Calendar day records",
    sourceTable: PRIVATE_CALENDAR_DAY_RECORDS_TABLE,
    startDate: day.date,
    status: "Recorded",
    time: "Full day",
    title,
  };
}

/** Keep only these people's day records; matches every spelling of an hr id. Pure. */
export function dayRecordsFor(days: readonly DayRecord[], hrIds: readonly string[]): DayRecord[] {
  const wanted = new Set<string>();
  for (const hrId of hrIds) for (const key of hrIdLookupKeys(hrId)) wanted.add(privateCalendarHrIdKey(key));
  wanted.delete("");
  return days.filter((day) => wanted.has(privateCalendarHrIdKey(day.hrId)));
}

type Row = Record<string, unknown>;

/** Every product manager's line Training days in the window — the QUESTION finder, never coverage. */
export type LineTrainingDaySummary = { date: string; lineCode: string; lineName: string; notes: string[]; people: number };

/** What each line's people wrote on its training days, one entry per line per day with 2+ people. Pure. */
export function summarizeLineTrainingDays(
  activities: ReadonlyArray<LineTrainingActivityRow & { note?: string | null }>,
  lineNames: ReadonlyMap<string, string>,
): LineTrainingDaySummary[] {
  const byKey = new Map<string, { notes: Set<string>; people: Set<string> }>();
  for (const row of activities) {
    if (row.activity_type !== "training") continue;
    const date = String(row.activity_date ?? "").slice(0, 10);
    const line = String(row.line_code ?? "").trim();
    const person = privateCalendarHrIdKey(String(row.rep_hr_id ?? ""));
    if (!isIsoDay(date) || !line || !person) continue;
    const entry = byKey.get(`${line}|${date}`) ?? { notes: new Set<string>(), people: new Set<string>() };
    entry.people.add(person);
    const note = String(row.note ?? "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (note) entry.notes.add(note);
    byKey.set(`${line}|${date}`, entry);
  }
  return [...byKey.entries()]
    .filter(([, entry]) => entry.people.size >= LINE_TRAINING_MIN_PEOPLE)
    .map(([key, entry]) => {
      const [lineCode, date] = key.split("|");
      return { date, lineCode, lineName: lineNames.get(lineCode) ?? lineCode, notes: [...entry.notes].slice(0, 8), people: entry.people.size };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.lineCode.localeCompare(b.lineCode));
}

export async function loadLineTrainingDays(window: { end: string; start: string }): Promise<{ days: DayRecord[]; lineDays: LineTrainingDaySummary[] }> {
  const [activities, managers, lines] = await Promise.all([
    fetchAllRowsKeyset<Row>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_activities")
          .select("id, line_code, activity_date, activity_type, rep_hr_id, note")
          .eq("is_test", false)
          .eq("activity_type", "training")
          .gte("activity_date", window.start)
          .lte("activity_date", window.end),
      { cursorColumn: "id", cursorOf: (row) => String(row.id) },
    ),
    fetchAllRows<Row>(
      () =>
        getSupabaseAdmin()
          .from("employees")
          .select("hr_id, job_title, line_id, hire_date, last_working_date")
          .ilike("job_title", "%product manager%"),
      "hr_id",
    ),
    fetchAllRows<Row>(() => getSupabaseAdmin().from("lines").select("id, code, name"), "id"),
  ]);
  const codeById = new Map<string, string>();
  const lineNames = new Map<string, string>();
  for (const line of lines) {
    const code = String(line.code ?? "").trim();
    if (!code) continue;
    codeById.set(String(line.id), code);
    lineNames.set(code, String(line.name ?? code));
  }
  const productManagers: LineProductManager[] = [];
  for (const row of managers) {
    if (!isLineProductManagerTitle(row.job_title as string | null)) continue;
    const lineCode = codeById.get(String(row.line_id ?? ""));
    const hrId = String(row.hr_id ?? "").trim();
    if (!lineCode || !hrId) continue;
    productManagers.push({
      hireDate: (row.hire_date as string | null) ?? null,
      hrId,
      lastWorkingDate: (row.last_working_date as string | null) ?? null,
      lineCode,
    });
  }
  const rows = activities as unknown as Array<LineTrainingActivityRow & { note?: string | null }>;
  return {
    days: selectLineTrainingDays({ activities: rows, lineNames, managers: productManagers, window }),
    lineDays: summarizeLineTrainingDays(rows, lineNames),
  };
}

async function loadStoredDayRecords(window: { end: string; start: string }): Promise<DayRecord[]> {
  const rows = await fetchAllRows<StoredDayRecordRow>(
    () =>
      getSupabaseAdmin()
        .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
        .select("id, employee_hr_id, record_date, activity_type, note, origin, status, entered_by_hr_id, named_by_hr_id, voided_at")
        .eq("status", "confirmed")
        .is("voided_at", null)
        .gte("record_date", window.start)
        .lte("record_date", window.end),
    "id",
  );
  const records = selectStoredDayRecords(rows, window);
  const namedBy = [...new Set(records.flatMap((record) => (record.namedByHrId ? [record.namedByHrId] : [])))];
  if (namedBy.length === 0) return records;
  const people = await fetchAllRows<Row>(
    () => getSupabaseAdmin().from("employees").select("hr_id, full_name, nickname").in("hr_id", namedBy),
    "hr_id",
  );
  const nameOf = new Map<string, string>();
  for (const person of people) {
    const name = String(person.nickname ?? "").trim() || String(person.full_name ?? "").trim();
    if (name) nameOf.set(privateCalendarHrIdKey(String(person.hr_id ?? "")), name);
  }
  return records.map((record) => ({
    ...record,
    namedByName: record.namedByHrId ? nameOf.get(privateCalendarHrIdKey(record.namedByHrId)) ?? null : null,
  }));
}

/** Every confirmed day record in the window. THROWS on a failed read — the deduction half. */
export async function loadDayRecords(window: { end: string; start: string }): Promise<DayRecord[]> {
  try {
    return await loadStoredDayRecords(window);
  } catch (error) {
    throw new Error(`Failed to load Private Calendar day records: ${(error as { message?: string } | null)?.message ?? String(error)}`);
  }
}

/** These people's day records as calendar items. Best-effort (`ready: false`) unless `strict`, which throws. */
export async function loadDayRecordPrivateCalendarItems(
  hrIds: readonly string[],
  start: string,
  end: string,
  options: { strict?: boolean } = {},
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  if (hrIds.length === 0) return { items: [], ready: true };
  try {
    const days = await loadDayRecords({ end, start });
    return { items: dayRecordsFor(days, hrIds).map(mapDayRecordToPrivateCalendarItem), ready: true };
  } catch (error) {
    // The company-wide pass feeds the deductions: there a silent "none" is a charge, so it throws.
    if (options.strict) throw error;
    console.error("[private-calendar] day records could not be read", error);
    return { items: [], ready: false };
  }
}
