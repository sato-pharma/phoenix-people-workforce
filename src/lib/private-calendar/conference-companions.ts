/**
 * "CONFERENCE DAY — ASK THE REP WHEN HE'S SUBMITTING" (owner, 2026-11-28). A rep saving a whole-day
 * Conference in Phoenix CRM is asked who from his line was there with him: a multi-tick of the line's
 * managers and product managers, optional, never a check on him. Each person he ticks gets a `pending`
 * day record (`origin = rep_named`), which covers NOTHING until the Super Admin confirms it on
 * /admin/private-calendar-day-records — never automatic.
 *
 * A test account never writes here, a half day never asks, and changing or clearing the day withdraws
 * the rep's still-pending names for that day (a decided one stays as the Super Admin left it).
 */

import { randomUUID } from "node:crypto";

import { PRIVATE_CALENDAR_DAY_RECORDS_TABLE } from "@/lib/private-calendar/day-records";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const CONFERENCE_COMPANIONS_MAX = 20;

export type ConferenceCompanion = { hrId: string; jobTitle: string; name: string };

type Row = Record<string, unknown>;

/** A line's manager or product manager — anyone on the line whose title says Manager. Pure. */
export function isConferenceCompanionTitle(jobTitle: string | null | undefined): boolean {
  return /manager/i.test(String(jobTitle ?? ""));
}

/** The ticked names that may be written: on the offered list, never the rep himself, at most 20. Pure. */
export function pickConferenceCompanions(input: {
  offered: readonly ConferenceCompanion[];
  repHrId: string;
  ticked: unknown;
}): ConferenceCompanion[] {
  const byKey = new Map(input.offered.map((person) => [privateCalendarHrIdKey(person.hrId), person]));
  const rep = privateCalendarHrIdKey(input.repHrId);
  const seen = new Set<string>();
  const out: ConferenceCompanion[] = [];
  for (const raw of Array.isArray(input.ticked) ? input.ticked : []) {
    const key = privateCalendarHrIdKey(String(raw ?? ""));
    const person = byKey.get(key);
    if (!person || key === rep || seen.has(key)) continue;
    seen.add(key);
    out.push(person);
    if (out.length >= CONFERENCE_COMPANIONS_MAX) break;
  }
  return out;
}

/** The people a rep of this line can name: the line's active managers and product managers. */
export async function loadConferenceCompanionChoices(lineCode: string | null | undefined, repHrId: string | null): Promise<ConferenceCompanion[]> {
  const code = String(lineCode ?? "").trim();
  if (!code) return [];
  const supabase = getSupabaseAdmin();
  const line = (await loadReferenceLines()).find((entry) => String(entry.code ?? "").trim() === code);
  if (!line || line.id === null) return [];
  const rows = await fetchAllRows<Row>(
    () =>
      supabase
        .from("employees")
        .select("hr_id, full_name, nickname, job_title")
        .eq("line_id", line.id)
        .ilike("employment_status", "active")
        .ilike("job_title", "%manager%"),
    "hr_id",
  );
  const rep = privateCalendarHrIdKey(repHrId ?? "");
  return rows
    .flatMap((row) => {
      const hrId = String(row.hr_id ?? "").trim();
      if (!hrId || privateCalendarHrIdKey(hrId) === rep || !isConferenceCompanionTitle(row.job_title as string)) return [];
      const name = String(row.nickname ?? "").trim() || String(row.full_name ?? "").trim() || "Unnamed employee";
      return [{ hrId, jobTitle: String(row.job_title ?? "").trim(), name }];
    })
    .sort((a, b) => a.jobTitle.localeCompare(b.jobTitle) || a.name.localeCompare(b.name));
}

/** Withdraw this rep's still-pending names for the day. */
export async function withdrawConferenceCompanions(repHrId: string, date: string): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
    .update({ voided_at: new Date().toISOString(), voided_by_hr_id: repHrId })
    .eq("origin", "rep_named")
    .eq("status", "pending")
    .ilike("named_by_hr_id", repHrId)
    .eq("record_date", date)
    .is("voided_at", null);
  if (error) throw new Error(`Could not withdraw the conference names: ${error.message}`);
}

/** Replace this rep's pending names for the day with the ones he ticked now. */
export async function recordConferenceCompanions(input: {
  date: string;
  lineCode: string | null;
  note: string | null;
  repHrId: string;
  ticked: unknown;
}): Promise<{ named: number }> {
  await withdrawConferenceCompanions(input.repHrId, input.date);
  const offered = await loadConferenceCompanionChoices(input.lineCode, input.repHrId);
  const people = pickConferenceCompanions({ offered, repHrId: input.repHrId, ticked: input.ticked });
  if (people.length === 0) return { named: 0 };
  const batchId = randomUUID();
  const { error } = await getSupabaseAdmin()
    .from(PRIVATE_CALENDAR_DAY_RECORDS_TABLE)
    .insert(
      people.map((person) => ({
        activity_type: "conference",
        batch_id: batchId,
        employee_hr_id: person.hrId,
        entered_by_hr_id: input.repHrId,
        named_by_hr_id: input.repHrId,
        note: input.note,
        origin: "rep_named",
        record_date: input.date,
        status: "pending",
      })),
    );
  if (error) throw new Error(`Could not save the conference names: ${error.message}`);
  return { named: people.length };
}
