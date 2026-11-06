// Recruitment / ATS — a district manager hands a CV back to the administrator, and the queue that
// receives it.
//
// The owner, 2026-09-01: *"make an option to tell them return this CV to the administrator because
// area not match — or any other situation ... and when they do this, the CV comes back in a folder
// based on the district manager who is sending it. And this returned CV is not any more in the
// district manager folder."*
//
// A return is a SUPPRESSION, not a move: the district folders are derived, so nothing is stored to
// "remove". This module is the database half of that — it writes the return, reads back the set of
// suppressions for one manager (handed to the pure placement rule), and serves the administrator's
// queue. The rule for WHICH folder a CV lands in stays in district-manager-folders.ts and is never
// restated here. Table shape and the why: supabase/migrations/20260901120000_ats_candidate_district_returns.sql.

import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { canonicalHrIdForDisplay } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { districtReturnSuppressionKey } from "@/lib/recruitment/district-manager-folders";
import { fetchAllRows } from "@/lib/supabase/paginated";

const RETURNS_TABLE = "ats_candidate_district_returns";

/** The reason a manager gives. 'area_not_match' is the owner's named case; 'other' carries a note. */
export type DistrictReturnReasonCode = "area_not_match" | "other";

/** What each reason reads as on screen. Kept beside the type so the API and the queue agree. */
export const DISTRICT_RETURN_REASON_LABELS: Record<DistrictReturnReasonCode, string> = {
  area_not_match: "Area doesn’t match",
  other: "Other reason",
};

export function isDistrictReturnReasonCode(value: unknown): value is DistrictReturnReasonCode {
  return value === "area_not_match" || value === "other";
}

const SUPPRESSING_STATUSES = ["open", "resolved"] as const;
const EMPTY_SUPPRESSIONS: ReadonlySet<string> = new Set<string>();

/** True when the error is "that table is not in this database yet" — same set the folders loader uses. */
function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "PGRST205") return true;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /schema cache/i.test(message);
}

/** True for a unique-violation — a second return of the same CV by the same manager. */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "23505";
}

function textOrNull(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The manager's name, snapshotted at return time so the admin queue is a plain read a leaver cannot blank. */
async function resolveManagerName(managerHrId: string): Promise<string | null> {
  const names = await namesByHrId([managerHrId]);
  return textOrNull(names.get(managerHrId));
}

export type RecordDistrictReturnInput = {
  candidateId: string;
  /** The actor's own hr id, taken from the session by the caller — never from the request body. */
  managerHrId: string;
  seatId?: string | null;
  seatLabel?: string | null;
  lineName?: string | null;
  regionName?: string | null;
  areaName?: string | null;
  reasonCode: DistrictReturnReasonCode;
  reasonNote?: string | null;
};

/**
 * Record a return. Idempotent: a second press (or a two-tab race) hits the partial unique index and
 * is treated as success — the CV is already back with the administrator, which is the honest answer
 * to the second click, exactly as returnCandidateToPool answers the second "put it back".
 */
export async function recordDistrictReturn(
  input: RecordDistrictReturnInput,
): Promise<{ recorded: boolean }> {
  const managerHrId = canonicalHrIdForDisplay(input.managerHrId);
  if (!managerHrId) throw new Error("A manager hr id is required to return a CV.");
  const candidateId = String(input.candidateId ?? "").trim();
  if (!candidateId) throw new Error("A candidate id is required to return a CV.");

  const managerName = await resolveManagerName(input.managerHrId);

  const { error } = await recruitmentDb()
    .from(RETURNS_TABLE)
    .insert({
      candidate_id: candidateId,
      manager_hr_id: managerHrId,
      manager_name: managerName,
      seat_id: textOrNull(input.seatId),
      seat_label: textOrNull(input.seatLabel),
      line_name: textOrNull(input.lineName),
      region_name: textOrNull(input.regionName),
      area_name: textOrNull(input.areaName),
      reason_code: input.reasonCode,
      reason_note: textOrNull(input.reasonNote),
    });

  if (error) {
    if (isUniqueViolation(error)) return { recorded: false };
    throw error;
  }
  return { recorded: true };
}

/**
 * The suppression keys for ONE manager — handed to placeCandidatesInDistrictFolders so a CV he has
 * returned drops out of his folders and stays in every other line's. Degrades to no suppressions on
 * a read failure or a missing table: the worst case then is that a returned CV briefly reappears in
 * his folder, which is a far better failure than taking My Candidates down. Same degrade discipline
 * as the folder loader, and the same reason the deploy can land before the migration.
 */
export async function loadManagerReturnSuppressions(
  managerHrId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  const key = canonicalHrIdForDisplay(managerHrId);
  if (!key) return EMPTY_SUPPRESSIONS;

  let data: Array<{ candidate_id: string }>;
  try {
    // Every standing return of this manager, paged to a short page by the unique `id`: a return a
    // response cap dropped would put that CV back in front of the manager who sent it back.
    data = await fetchAllRows<{ candidate_id: string }>(
      () =>
        recruitmentDb()
          .from(RETURNS_TABLE)
          .select("candidate_id")
          .eq("manager_hr_id", key)
          .in("status", SUPPRESSING_STATUSES),
      "id",
    );
  } catch (error) {
    if (!isMissingRelation(error)) {
      logError("District returns could not be read for the folder view", {
        error,
        labels: { event: "district_returns_suppression_read_failed" },
      });
    }
    return EMPTY_SUPPRESSIONS;
  }

  const set = new Set<string>();
  for (const row of data) {
    set.add(districtReturnSuppressionKey(managerHrId, String((row as { candidate_id: string }).candidate_id)));
  }
  return set;
}

/**
 * Has this one manager returned this one CV? The per-CV access check reads it so a returned CV is no
 * longer "in his district" for the purposes of opening its file or comment thread. Degrades to
 * "not suppressed" on failure, which keeps access working rather than locking a manager out of a CV
 * over a transient read error.
 */
export async function isReturnSuppressed(
  managerHrId: string | null | undefined,
  candidateId: string,
): Promise<boolean> {
  const key = canonicalHrIdForDisplay(managerHrId);
  const id = String(candidateId ?? "").trim();
  if (!key || !id) return false;

  const { data, error } = await recruitmentDb()
    .from(RETURNS_TABLE)
    .select("id")
    .eq("manager_hr_id", key)
    .eq("candidate_id", id)
    .in("status", SUPPRESSING_STATUSES)
    .limit(1);

  if (error) {
    if (!isMissingRelation(error)) {
      logError("District return check failed for the access gate", {
        error,
        labels: { event: "district_return_access_check_failed" },
      });
    }
    return false;
  }
  return (data ?? []).length > 0;
}

// ── The administrator's queue ─────────────────────────────────────────────────────────────────────

export type ReturnedCvItem = {
  returnId: string;
  candidateId: string;
  candidateName: string | null;
  areaName: string | null;
  seatLabel: string | null;
  lineName: string | null;
  regionName: string | null;
  reasonCode: DistrictReturnReasonCode;
  reasonLabel: string;
  reasonNote: string | null;
  returnedAt: string;
};

export type ReturnedCvReasonGroup = {
  reasonCode: DistrictReturnReasonCode;
  reasonLabel: string;
  items: ReturnedCvItem[];
};

/** One returning manager's pile, grouped by the reason he gave — the owner's asked-for shape. */
export type ReturnedCvManagerGroup = {
  managerHrId: string;
  managerName: string | null;
  total: number;
  reasons: ReturnedCvReasonGroup[];
};

type ReturnRow = {
  id: string;
  candidate_id: string;
  manager_hr_id: string;
  manager_name: string | null;
  seat_label: string | null;
  line_name: string | null;
  region_name: string | null;
  area_name: string | null;
  reason_code: string;
  reason_note: string | null;
  returned_at: string;
};

const NAME_CHUNK = 50;

/** Candidate display names for the queue, live from ats_candidates. Chunked at 50 — a PostgREST
 *  `.in()` carrying hundreds of ids silently returns nothing. */
async function loadCandidateNames(candidateIds: readonly string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>();
  if (candidateIds.length === 0) return names;
  const supabase = recruitmentDb();
  for (let index = 0; index < candidateIds.length; index += NAME_CHUNK) {
    const chunk = candidateIds.slice(index, index + NAME_CHUNK);
    const { data, error } = await supabase.from("ats_candidates").select("id,full_name").in("id", chunk);
    if (error) {
      logError("Returned CV queue could not read candidate names", {
        error,
        labels: { event: "district_returns_candidate_names_failed" },
      });
      continue;
    }
    for (const row of data ?? []) {
      const record = row as { id: string; full_name: string | null };
      names.set(String(record.id), textOrNull(record.full_name));
    }
  }
  return names;
}

/**
 * The open returns, grouped by returning manager and then by reason, newest first within a reason.
 *
 * Degrades to an empty queue (never throws) when the table is not in this database yet — the admin
 * page ships on a merge to `main` minutes before its migration is confirmed, and an empty queue is a
 * better failure than a 500 on the page.
 */
export async function listReturnedCvQueue(): Promise<ReturnedCvManagerGroup[]> {
  let rows: ReturnRow[];
  try {
    // Every open return, paged to a short page by the unique `id`: this is the whole queue the admin
    // page shows, grouped by manager, so a row a response cap dropped would be a return nobody sees.
    rows = await fetchAllRows<ReturnRow>(
      () =>
        recruitmentDb()
          .from(RETURNS_TABLE)
          .select("id,candidate_id,manager_hr_id,manager_name,seat_label,line_name,region_name,area_name,reason_code,reason_note,returned_at")
          .eq("status", "open")
          .order("returned_at", { ascending: false }),
      "id",
    );
  } catch (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }

  if (rows.length === 0) return [];

  const candidateIds = [...new Set(rows.map((row) => String(row.candidate_id)))];
  const names = await loadCandidateNames(candidateIds);

  // Group by manager (canonical), preserving newest-first order — the first row seen for a manager
  // fixes his place in the list and his snapshot name.
  const byManager = new Map<
    string,
    { managerHrId: string; managerName: string | null; reasons: Map<DistrictReturnReasonCode, ReturnedCvItem[]> }
  >();

  for (const row of rows) {
    const managerKey = canonicalHrIdForDisplay(row.manager_hr_id) ?? String(row.manager_hr_id);
    let group = byManager.get(managerKey);
    if (!group) {
      group = { managerHrId: managerKey, managerName: textOrNull(row.manager_name), reasons: new Map() };
      byManager.set(managerKey, group);
    }
    if (!group.managerName) group.managerName = textOrNull(row.manager_name);

    const reasonCode = isDistrictReturnReasonCode(row.reason_code) ? row.reason_code : "other";
    const items = group.reasons.get(reasonCode) ?? [];
    items.push({
      returnId: String(row.id),
      candidateId: String(row.candidate_id),
      candidateName: names.get(String(row.candidate_id)) ?? null,
      areaName: textOrNull(row.area_name),
      seatLabel: textOrNull(row.seat_label),
      lineName: textOrNull(row.line_name),
      regionName: textOrNull(row.region_name),
      reasonCode,
      reasonLabel: DISTRICT_RETURN_REASON_LABELS[reasonCode],
      reasonNote: textOrNull(row.reason_note),
      returnedAt: String(row.returned_at),
    });
    group.reasons.set(reasonCode, items);
  }

  // 'area_not_match' before 'other', so the specific reason reads first.
  const reasonOrder: DistrictReturnReasonCode[] = ["area_not_match", "other"];
  return [...byManager.values()].map((group) => {
    const reasons: ReturnedCvReasonGroup[] = reasonOrder
      .filter((code) => group.reasons.has(code))
      .map((code) => ({
        reasonCode: code,
        reasonLabel: DISTRICT_RETURN_REASON_LABELS[code],
        items: group.reasons.get(code) ?? [],
      }));
    const total = reasons.reduce((sum, reason) => sum + reason.items.length, 0);
    return { managerHrId: group.managerHrId, managerName: group.managerName, total, reasons };
  });
}

/**
 * Mark a return handled — it leaves the administrator's queue but STAYS suppressed, because the
 * manager's decision to return it was deliberate and re-showing it would re-ask a question he
 * already answered. Only an open row moves, so a double-press is a no-op rather than an overwrite.
 */
export async function resolveDistrictReturn(input: {
  returnId: string;
  resolvedByHrId: string | null | undefined;
  resolutionNote?: string | null;
}): Promise<void> {
  const id = String(input.returnId ?? "").trim();
  if (!id) throw new Error("A return id is required to resolve it.");

  const { error } = await recruitmentDb()
    .from(RETURNS_TABLE)
    .update({
      status: "resolved",
      resolved_at: new Date().toISOString(),
      resolved_by_hr_id: canonicalHrIdForDisplay(input.resolvedByHrId),
      resolution_note: textOrNull(input.resolutionNote),
    })
    .eq("id", id)
    .eq("status", "open");

  if (error) throw error;
}
