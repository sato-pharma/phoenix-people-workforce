// Milestones — the record of what was printed, and the latch that stops the reminder.
//
// Two tables, two questions (see the migration 20260923212006_milestone_card_prints_and_notice_marks):
//   milestone_card_prints  — an append-only log. "What have we produced, and for whom?"
//   milestone_notice_marks — a per-viewer latch. "Has THIS person been told about THIS occasion?"
//
// Modelled on src/lib/recruitment/inbound/whatsapp-outbound-log.ts, and it keeps that module's one
// rule: the WRITE never throws and never changes the thing it records. A card that printed must
// reach the owner's hands whatever the log does — a print row is worth having, it is not worth
// costing him the card.
//
// ── THE IDENTITY OF ONE OCCASION ─────────────────────────────────────────────
// (subject_hr_id, period_spec, derived_on), where `derived_on` is what the ARITHMETIC computed —
// never the date somebody typed over it on the card. The two readers below and the pump all key on
// exactly this triple, through `occurrenceKey`, so they cannot drift.

import { logWarning } from "@/lib/observability/log";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { formatPlainDateIso, type PlainDate } from "./periods";

/** The three fields that identify one occasion. `periodSpec` is the short form: `1m`, `1y`, `b4`. */
export type MilestoneOccurrence = {
  subjectHrId: string;
  periodSpec: string;
  /** The arithmetic's date, ISO — the identity, never the printed date. */
  derivedOn: string;
};

/** The one string every reader and the pump compare on. Upper-cases the id so a casing difference
 *  in one feed cannot split an occasion in two. */
export function occurrenceKey(occurrence: MilestoneOccurrence): string {
  return `${occurrence.subjectHrId.trim().toUpperCase()}|${occurrence.periodSpec.trim().toLowerCase()}|${occurrence.derivedOn}`;
}

export type MilestonePhotoSource = "record" | "upload" | "none";

/** The row written to `public.milestone_card_prints`. */
export type MilestonePrintRow = {
  subject_hr_id: string;
  printed_name: string;
  hire_date: string | null;
  period_spec: string;
  derived_on: string;
  milestone_on: string;
  format: string;
  variant: string;
  file_name: string | null;
  photo_source: MilestonePhotoSource;
  actor_login_id: string | null;
  actor_hr_id: string | null;
  actor_name: string | null;
};

/**
 * Builds the print row. Pure, and separated from the write on purpose: this is the part worth
 * pinning in a test, and it must be checkable without a database.
 *
 * `derivedOn` and `milestoneOn` are BOTH stored: the first is the identity (the arithmetic), the
 * second is what the sheet actually carried, which whoever printed it may have typed by hand.
 */
export function buildMilestonePrintRow(input: {
  subjectHrId: string;
  printedName: string;
  hireDate: PlainDate | null;
  periodSpec: string;
  derivedOn: PlainDate;
  milestoneOn: PlainDate;
  format: "pdf" | "png";
  variant: string;
  fileName: string | null;
  photoSource: MilestonePhotoSource;
  actorLoginId: string | null;
  actorHrId: string | null;
  actorName: string | null;
}): MilestonePrintRow {
  return {
    subject_hr_id: input.subjectHrId.trim().toUpperCase(),
    printed_name: input.printedName,
    hire_date: input.hireDate ? formatPlainDateIso(input.hireDate) : null,
    period_spec: input.periodSpec.trim().toLowerCase(),
    derived_on: formatPlainDateIso(input.derivedOn),
    milestone_on: formatPlainDateIso(input.milestoneOn),
    format: input.format,
    variant: input.variant,
    file_name: input.fileName,
    photo_source: input.photoSource,
    actor_login_id: input.actorLoginId,
    actor_hr_id: input.actorHrId,
    actor_name: input.actorName,
  };
}

/**
 * Writes one print row. NEVER THROWS.
 *
 * Written after the card is successfully produced, so the row records an event that happened. A
 * reprint is a second row, deliberately (the table is append-only, not an upsert) — "we printed
 * this twice" is a fact worth keeping.
 */
export async function recordMilestonePrint(row: MilestonePrintRow): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().from("milestone_card_prints").insert(row);
    if (error) {
      logWarning("Milestone card print not logged", {
        context: { code: (error as { code?: string }).code ?? null, subject: row.subject_hr_id },
        labels: { event: "milestone_print_log_failed" },
      });
    }
  } catch (error) {
    logWarning("Milestone card print log threw", {
      error,
      labels: { event: "milestone_print_log_threw" },
    });
  }
}

/**
 * Every occasion a card has ALREADY been printed for, inside `[from, to]`. Global — not per viewer.
 *
 * 🔴 FAILS TOWARDS THE BADGE HIDING, DELIBERATELY. An unreadable print log returns an empty set, so
 * the "already printed" badge on the due list simply does not show and the pump does not treat any
 * occasion as done — the worst case is a reminder one day too many and a missing tick, never a card
 * silently suppressed because a read failed.
 */
export async function loadMilestonePrintMarks(from: PlainDate, to: PlainDate): Promise<Set<string>> {
  try {
    // Paged to the last row: a window with more prints than one response carries must not lose the
    // rest, or the "already printed" badge would silently go missing on those occasions.
    const supabase = getSupabaseAdmin();
    const data = await fetchAllRows<{ subject_hr_id?: string; period_spec?: string; derived_on?: string }>(
      () =>
        supabase
          .from("milestone_card_prints")
          .select("subject_hr_id,period_spec,derived_on")
          .gte("derived_on", formatPlainDateIso(from))
          .lte("derived_on", formatPlainDateIso(to)),
      "id",
    );
    const keys = new Set<string>();
    for (const row of data) {
      if (!row.subject_hr_id || !row.period_spec || !row.derived_on) continue;
      keys.add(occurrenceKey({ subjectHrId: row.subject_hr_id, periodSpec: row.period_spec, derivedOn: row.derived_on }));
    }
    return keys;
  } catch (error) {
    logWarning("Milestone print marks unreadable", { error, labels: { event: "milestone_print_marks_failed" } });
    return new Set();
  }
}

/** One row of the print log, as the history view reads it back. Names, not codes (AGENTS.md §4). */
export type MilestonePrintHistoryRow = {
  created_at: string;
  subject_hr_id: string;
  printed_name: string;
  period_spec: string;
  derived_on: string;
  milestone_on: string;
  format: string;
  variant: string;
  file_name: string | null;
  photo_source: MilestonePhotoSource;
  actor_hr_id: string | null;
  actor_name: string | null;
  actor_login_id: string | null;
};

/**
 * The print log itself — WHO was congratulated, with WHICH card, WHEN, and by WHOM — over a window
 * of print dates (`created_at`), newest first. This is the reader the append-only log was built for:
 * the "already printed" badge answers only "in the current thirty days"; a Super Admin looking back
 * at last quarter's cards needs the log surfaced.
 *
 * 🔴 FAILS TOWARDS AN EMPTY LIST, never a throw. A history view that cannot read the log shows
 * nothing rather than breaking the page; the log is a record, not a control, so a read failure must
 * not cost anyone the rest of the module.
 *
 * EVERY row of the window is read, page by page. This is a record a Super Admin looks back through,
 * and the XLSX carries the same rows, so a fixed row ceiling would silently drop the OLDEST prints of
 * a long window with no sign on the page.
 */
export async function loadMilestonePrintHistory(
  fromIso: string,
  toIso: string,
): Promise<MilestonePrintHistoryRow[]> {
  try {
    const supabase = getSupabaseAdmin();
    const data = await fetchAllRows<MilestonePrintHistoryRow>(
      () =>
        supabase
          .from("milestone_card_prints")
          .select(
            "created_at,subject_hr_id,printed_name,period_spec,derived_on,milestone_on,format,variant,file_name,photo_source,actor_hr_id,actor_name,actor_login_id",
          )
          // `created_at` is a timestamptz; the window is print DATES, so the upper bound reaches the end
          // of `toIso` rather than its midnight, or a card printed later that day would fall outside it.
          .gte("created_at", `${fromIso}T00:00:00Z`)
          .lte("created_at", `${toIso}T23:59:59.999Z`)
          // Newest first; the unique `id` the pager appends settles rows printed in the same instant.
          .order("created_at", { ascending: false }),
      "id",
    );
    return data.filter((row) => Boolean(row.subject_hr_id));
  } catch (error) {
    logWarning("Milestone print history unreadable", { error, labels: { event: "milestone_print_history_failed" } });
    return [];
  }
}

/**
 * Every occasion one viewer has already SEEN, inside `[from, to]`.
 *
 * 🔴 FAILS TOWARDS THE PUMP FIRING, DELIBERATELY — the opposite direction to the print marks above.
 * If the mark table cannot be read, this returns an empty set, so nothing is treated as
 * acknowledged and the reminder fires again. A reminder that stops because a read failed is the
 * exact silent non-delivery this codebase's notification files document at length; a reminder one
 * day too many is an annoyance.
 */
export async function loadSeenOccurrenceKeys(
  viewerHrId: string,
  from: PlainDate,
  to: PlainDate,
): Promise<Set<string>> {
  const viewer = viewerHrId.trim().toUpperCase();
  if (!viewer) return new Set();
  try {
    // Paged to the last row. This table has no `id`; for one viewer the unique key is the other three
    // columns of its unique constraint, so they are ordered together and `period_spec` goes last.
    const supabase = getSupabaseAdmin();
    const data = await fetchAllRows<{ subject_hr_id?: string; period_spec?: string; derived_on?: string }>(
      () =>
        supabase
          .from("milestone_notice_marks")
          .select("subject_hr_id,period_spec,derived_on")
          .eq("seen_by_hr_id", viewer)
          .gte("derived_on", formatPlainDateIso(from))
          .lte("derived_on", formatPlainDateIso(to))
          .order("derived_on", { ascending: true })
          .order("subject_hr_id", { ascending: true }),
      "period_spec",
    );
    const keys = new Set<string>();
    for (const row of data) {
      if (!row.subject_hr_id || !row.period_spec || !row.derived_on) continue;
      keys.add(occurrenceKey({ subjectHrId: row.subject_hr_id, periodSpec: row.period_spec, derivedOn: row.derived_on }));
    }
    return keys;
  } catch (error) {
    logWarning("Milestone seen marks unreadable", { error, labels: { event: "milestone_seen_marks_failed" } });
    return new Set();
  }
}

/**
 * Records that one viewer has seen these occasions. Idempotent (`on conflict do nothing`), so it is
 * safe to fire on every page mount. Returns how many rows the write inserted; 0 is a normal answer
 * (everything was already marked). Never throws — a mark that does not land means tomorrow reminds
 * the viewer again, which is the safe direction.
 */
export async function markMilestonesSeen(
  viewerHrId: string,
  occurrences: readonly MilestoneOccurrence[],
): Promise<number> {
  const viewer = viewerHrId.trim().toUpperCase();
  if (!viewer || occurrences.length === 0) return 0;
  try {
    // De-duplicate before the insert: one page can list a person twice (a month and a year on the
    // same day), and two identical rows in one insert would trip the unique constraint as a batch.
    const seen = new Set<string>();
    const rows: Array<{ seen_by_hr_id: string; subject_hr_id: string; period_spec: string; derived_on: string }> = [];
    for (const occurrence of occurrences) {
      const key = occurrenceKey(occurrence);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        seen_by_hr_id: viewer,
        subject_hr_id: occurrence.subjectHrId.trim().toUpperCase(),
        period_spec: occurrence.periodSpec.trim().toLowerCase(),
        derived_on: occurrence.derivedOn,
      });
    }
    const { data, error } = await getSupabaseAdmin()
      .from("milestone_notice_marks")
      .upsert(rows, { onConflict: "seen_by_hr_id,derived_on,subject_hr_id,period_spec", ignoreDuplicates: true })
      .select("subject_hr_id");
    if (error) throw error;
    return (data ?? []).length;
  } catch (error) {
    logWarning("Milestone seen marks not written", { error, labels: { event: "milestone_seen_marks_write_failed" } });
    return 0;
  }
}
