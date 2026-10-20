/**
 * Phoenix CRM — the refused-readings board, for the Super Admin and the SFE Manager.
 *
 * The only READER of `phoenix_crm_refused_readings` (the recorder, `refused-readings.ts`, is the only
 * writer). Owner, 2026-10-03: "record the refused readings so the next refusal is traceable"; and, the
 * same night it caught its first real case (nine refusals in 67 seconds from one rep whose phone was
 * fine), "build the refused readings view for the SFE".
 *
 * WHO READS IT: the same two people as the integrity board, for the same reason — a rep's refused
 * attempts are a fact about HIS phone, and the SFE is who can help him. It lives behind `/admin`, which
 * no rep can open, so the field app's bundle neither imports this file nor has a route that reaches it.
 *
 * 🔴 THE PHONE'S OWN MOCK-LOCATION ANSWER IS THE SUPER ADMIN'S ALONE, HERE AS ON THE INTEGRITY BOARD
 * (owner, 2026-10-02). It is not filtered out of a screen for the SFE Manager: the column is never
 * QUERIED for him, so it cannot reach this process, let alone a page.
 *
 * WHY A 404 AND NOT A 403. A message naming this board tells the person asking that a record of
 * refusals exists. To everybody outside the audience it is simply not a thing that is here.
 *
 * Nothing here acts: no button, no decision, no write, no notification. A refusal is not a violation
 * and nobody is told they were looked at.
 */

import { notFoundError } from "@/lib/http/api-errors";
import {
  attemptOutcome,
  parseBlockedPermission,
  parseRefusedReason,
  summariseByRep,
  type AttemptOutcome,
  type LaterSave,
  type RefusedAttempt,
  type RepRefusals,
} from "@/lib/phoenix-crm/refused-readings-rules";
import { type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { photoPathTerritory } from "@/lib/phoenix-crm/server/photos";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

/** How far back the board reads. Two weeks: long enough to see a habit, short enough to be a worklist. */
export const REFUSED_READINGS_WINDOW_DAYS = 14;
/** PostgREST's own row ceiling; a result this size is a truncated read and the page says so. */
const ROW_LIMIT = 1000;
/** The attempts the page prints in full. The by-rep summary still counts every row read. */
const LATEST_LIMIT = 100;
/** A `.in()` carrying several hundred ids comes back empty past some URL length — never read wider. */
const CHUNK = 50;
/** How many of those fifty-id reads are in flight at once (Phoenix CRM performance audit, 2026-10-16). */
const CHUNK_READS_AT_ONCE = 4;

/** Where each fifty-id chunk starts: 0, 50, 100, … — the same chunks the one-at-a-time walk read. */
function chunkStarts(length: number): number[] {
  const starts: number[] = [];
  for (let index = 0; index < length; index += CHUNK) starts.push(index);
  return starts;
}

export type RefusedAttemptRow = RefusedAttempt & {
  repName: string;
  customerName: string | null;
  outcome: AttemptOutcome;
  /** The phone's own mock-location answer. Super Admin only; null for everyone else AND when not asked. */
  deviceMocked: boolean | null;
  /**
   * Where the photo the phone sent sits in the bucket, or null — a refusal before 3 October kept no
   * pointer, and a refusal for no position at all may have had no picture yet. It is a POINTER, never
   * a link: the page signs it through the scoped photo route, which is what keeps it ten minutes long.
   */
  photoPath: string | null;
};

/** A stored pointer is shown only if it is the shape of a real slot — anything else is a row with no photo. */
function storedPhotoPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const owner = photoPathTerritory(value);
  // `is_test` rows never reach this board, so a `test/` path here is not one of ours.
  return owner && !owner.isTest ? value : null;
}

export type RepRefusalRow = RepRefusals & { repName: string };

export type RefusedReadingsBoard = {
  windowDays: number;
  /** Every refusal read in the window, before the page's own cut of the latest ones. */
  total: number;
  /** True when the read hit the row ceiling, so the counts are a floor rather than the whole window. */
  truncated: boolean;
  reps: RepRefusalRow[];
  /** Reps with at least one customer still blocked. */
  stuckReps: number;
  latest: RefusedAttemptRow[];
};

/** The Super Admin and the SFE Manager, and nobody else — one predicate for the service and the page. */
export function canReadRefusedReadings(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin || viewer.isSfeManager;
}

/** The phone's mock-location answer is position evidence: the Super Admin's alone (owner, 2026-10-02). */
export function readsMockAnswer(viewer: PhoenixCrmViewer): boolean {
  return viewer.isSuperAdmin;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadLaterSaves(attempts: readonly RefusedAttempt[]): Promise<LaterSave[]> {
  const supabase = getSupabaseAdmin();
  const tied = attempts.filter((attempt) => attempt.customerId !== null);
  const customerIds = [...new Set(tied.map((attempt) => String(attempt.customerId)))];
  if (customerIds.length === 0) return [];
  // Nothing before the oldest refusal can resolve one, so the read never goes wider than that.
  const since = tied.reduce((oldest, attempt) => (attempt.refusedAt < oldest ? attempt.refusedAt : oldest), tied[0]!.refusedAt);
  // The chunks are asked a few at a time rather than one after another, and read back in their own
  // order below, so the saves list comes out exactly as the one-at-a-time walk built it.
  const pages = await mapWithConcurrency(chunkStarts(customerIds.length), CHUNK_READS_AT_ONCE, (index) => {
    const slice = customerIds.slice(index, index + CHUNK);
    return Promise.all([
      supabase
        .from("phoenix_crm_visits")
        .select("customer_id, entered_by_hr_id, captured_at")
        .in("customer_id", slice)
        .gte("captured_at", since)
        .eq("is_test", false),
      supabase
        .from("phoenix_crm_places")
        .select("customer_id, created_by_hr_id, created_at")
        .in("customer_id", slice)
        .gte("created_at", since)
        .eq("is_test", false),
    ]);
  });
  const saves: LaterSave[] = [];
  for (const [visits, places] of pages) {
    // Non-fatal by design: a failed read here must leave the refusals visible, with the outcome
    // unproven rather than the whole board blank. The outcome is then read as "not through yet",
    // which is the safe direction — a rep is never reported as having got through on a read that failed.
    if (visits.error || places.error) continue;
    for (const row of (visits.data ?? []) as Row[]) {
      saves.push({
        subjectKind: "visit",
        repHrId: String(row.entered_by_hr_id ?? ""),
        customerId: String(row.customer_id),
        savedAt: String(row.captured_at),
      });
    }
    for (const row of (places.data ?? []) as Row[]) {
      saves.push({
        subjectKind: "place",
        repHrId: String(row.created_by_hr_id ?? ""),
        customerId: String(row.customer_id),
        savedAt: String(row.created_at),
      });
    }
  }
  return saves;
}

/**
 * Load the board. Checked here as well as on the page, because this is the one place where reading
 * the data IS the sensitive act.
 */
export async function loadRefusedReadingsBoard(viewer: PhoenixCrmViewer, now: Date = new Date()): Promise<RefusedReadingsBoard> {
  if (!canReadRefusedReadings(viewer)) throw notFoundError("Not found.");

  const supabase = getSupabaseAdmin();
  const since = new Date(now.getTime() - REFUSED_READINGS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const mock = readsMockAnswer(viewer);
  // `device_mocked` is named in the select ONLY for the Super Admin. For anyone else it is not asked
  // of the database at all, so the SFE Manager's process never holds it.
  // `photo_path` is asked for EVERYONE: the picture is what the phone sent to prove where it stood, and the
  // two readers see the same one. It is the mock-location answer, not the photo, that is the Super Admin's.
  // `blocked_permission` is asked for EVERYONE: it is the difference between "this phone's location
  // switch is off" and "the reading was wide", and the SFE is exactly who acts on the first.
  // `distance_meters` is asked for EVERYONE: on a visit refused for being logged away from the customer's
  // validated photo (owner, 2026-10-20) the metres ARE the refusal, and both readers act on them.
  const columns = `id, subject_kind, reason, blocked_permission, rep_hr_id, customer_id, refused_at, accuracy_meters, photo_accuracy_meters, max_accuracy_meters, distance_meters, photo_path${mock ? ", device_mocked" : ""}`;
  const { data, error } = await supabase
    .from("phoenix_crm_refused_readings")
    .select(columns)
    .gte("refused_at", since)
    // The Super Admin's own trial entries never belong on the SFE's worklist, nor on his own.
    .eq("is_test", false)
    .order("refused_at", { ascending: false })
    .limit(ROW_LIMIT);
  throwIfError(error);
  const rows = (data ?? []) as unknown as Row[];

  const attempts: RefusedAttempt[] = rows.map((row) => ({
    id: String(row.id),
    subjectKind: row.subject_kind === "place" ? "place" : "visit",
    // Every reason the table allows, read as itself. A two-way read printed the "too rough" sentence
    // over every `off_listing` row for eight days — see `parseRefusedReason`.
    reason: parseRefusedReason(row.reason),
    repHrId: String(row.rep_hr_id ?? ""),
    customerId: row.customer_id ? String(row.customer_id) : null,
    refusedAt: String(row.refused_at),
    accuracyMeters: numberOrNull(row.accuracy_meters),
    photoAccuracyMeters: numberOrNull(row.photo_accuracy_meters),
    maxAccuracyMeters: numberOrNull(row.max_accuracy_meters),
    blockedPermission: parseBlockedPermission(row.blocked_permission),
    distanceMeters: numberOrNull(row.distance_meters),
  }));
  if (attempts.length === 0) {
    return { windowDays: REFUSED_READINGS_WINDOW_DAYS, total: 0, truncated: false, reps: [], stuckReps: 0, latest: [] };
  }

  const customerIds = [...new Set(attempts.map((attempt) => attempt.customerId).filter((id): id is string => id !== null))];
  // The customers' names, the reps' names and the later saves do not depend on one another, so the
  // three are asked at once instead of the names first and the other two after.
  const [customerPages, people, saves] = await Promise.all([
    mapWithConcurrency(chunkStarts(customerIds.length), CHUNK_READS_AT_ONCE, async (index) =>
      await supabase
        .from("phoenix_crm_customers")
        .select("id, name")
        .in("id", customerIds.slice(index, index + CHUNK)),
    ),
    loadPeopleNames(attempts.map((attempt) => attempt.repHrId)),
    loadLaterSaves(attempts),
  ]);
  const customerNames = new Map<string, string>();
  for (const { data: customers, error: customerError } of customerPages) {
    // Non-fatal: a customer shown as "—" is better than a board that will not open. Read back in
    // chunk order and stopped at the first failed chunk, exactly as the one-at-a-time walk stopped.
    if (customerError) break;
    for (const customer of (customers ?? []) as Row[]) customerNames.set(String(customer.id), String(customer.name ?? ""));
  }

  const reps = summariseByRep(attempts, saves).map((entry) => ({ ...entry, repName: nameOf(people, entry.repHrId) || entry.repHrId }));
  const photoById = new Map<string, string>();
  for (const row of rows) {
    const photoPath = storedPhotoPath(row.photo_path);
    if (photoPath) photoById.set(String(row.id), photoPath);
  }
  const mocked = new Map<string, boolean | null>();
  if (mock) {
    for (const row of rows) mocked.set(String(row.id), typeof row.device_mocked === "boolean" ? row.device_mocked : null);
  }

  return {
    windowDays: REFUSED_READINGS_WINDOW_DAYS,
    total: attempts.length,
    truncated: rows.length >= ROW_LIMIT,
    reps,
    stuckReps: reps.filter((entry) => entry.targets - entry.gotThrough > 0).length,
    latest: attempts.slice(0, LATEST_LIMIT).map((attempt) => ({
      ...attempt,
      repName: nameOf(people, attempt.repHrId) || attempt.repHrId,
      customerName: attempt.customerId ? customerNames.get(attempt.customerId) ?? null : null,
      outcome: attemptOutcome(attempt, saves),
      deviceMocked: mocked.get(attempt.id) ?? null,
      photoPath: photoById.get(attempt.id) ?? null,
    })),
  };
}
