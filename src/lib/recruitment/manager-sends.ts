// Recruitment / ATS — the send trail, one row per (candidate, manager).
//
// WHY THIS EXISTS. Until 2026-08-30 a send lived in single columns on the candidate row, so a CV
// could be "sent to" exactly one person. Sending it to a second manager overwrote the first, and
// the overwritten thing WAS the record of the send — so the CV disappeared from the first
// manager's list leaving nothing behind to notice. The owner's answer when asked whether that
// should be allowed at all: "yes a CV can go to two managers". This module is that fan-out.
//
// DEGRADES, NEVER THROWS, ON A MISSING TABLE. Code ships on a merge to `main` and serves traffic
// within minutes; the migration that creates this table is a separate, announced step around it. In
// the window between the two, PostgREST answers a read or a write naming a table it has never heard
// of with PGRST205 (schema cache) and Postgres with 42P01 — and the standing repo rule is that
// those two are ONE condition behind one helper, because whichever you check alone is the one that
// arrives. On that condition every function here becomes a no-op and the caller falls back to the
// old columns, which still work. Any other failure is real and is thrown.

import { canonicalHrIdKey, hrIdLookupKeys } from "@/lib/hr-id";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import type { SentForPosition } from "@/lib/recruitment/types";

/** The table, named once so a rename is one edit and a typo cannot half-apply. */
export const MANAGER_SENDS_TABLE = "ats_candidate_manager_sends";

/**
 * One recorded send, as the manager's own screen needs to read it.
 *
 * The manager's seat and the position are BOTH per-send rather than per-candidate. Two managers can
 * be sent the same person for two different vacancies — the ordinary case for a Medical
 * Representative CV that suits Tanta and Mansoura — and reading either off the candidate row would
 * file one manager's copy under the other manager's seat.
 */
export type ManagerSend = {
  candidateId: string;
  managerHrId: string;
  managerName: string | null;
  managerArea: string | null;
  managerJobTitle: string | null;
  managerRegion: string | null;
  position: SentForPosition | null;
  sentAt: string;
};

/**
 * True when the table is not in this database yet.
 *
 * Narrow on purpose, and it checks BOTH codes: a missing table answers PGRST205 out of PostgREST's
 * own schema cache with no Postgres code attached at all, while 42P01 is what arrives when the
 * cache is warm. Matching one of them leaves the other as a thrown 500 on a whole page.
 */
function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "PGRST205" || code === "42P01") return true;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /schema cache/i.test(message) && message.includes(MANAGER_SENDS_TABLE);
}

type SendDbRow = {
  candidate_id?: unknown;
  manager_hr_id?: unknown;
  manager_name?: unknown;
  manager_area?: unknown;
  manager_job_title?: unknown;
  manager_region?: unknown;
  sent_for_area?: unknown;
  sent_for_job_title?: unknown;
  sent_for_line?: unknown;
  sent_for_region?: unknown;
  sent_for_vacancy_id?: unknown;
  sent_at?: unknown;
};

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * `Number(null)` is 0, not NaN, so a bare finiteness check would turn an absent vacancy id into
 * vacancy 0 — a real-looking foreign key pointing at nothing. Same coercer the candidate mapper uses.
 */
function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mapSend(row: SendDbRow): ManagerSend {
  const areaName = textOrNull(row.sent_for_area);
  const jobTitle = textOrNull(row.sent_for_job_title);
  const lineName = textOrNull(row.sent_for_line);
  return {
    candidateId: String(row.candidate_id ?? ""),
    managerArea: textOrNull(row.manager_area),
    managerHrId: String(row.manager_hr_id ?? ""),
    managerJobTitle: textOrNull(row.manager_job_title),
    managerName: textOrNull(row.manager_name),
    managerRegion: textOrNull(row.manager_region),
    // Present whenever ANY part was recorded, matching mapCandidate: a free-typed position has no
    // vacancy id, and a vacancy picked before the line was known still names an area and a title.
    // Requiring all of them would silently unfile a candidate the recruiter did file.
    position:
      areaName || jobTitle || lineName
        ? {
            areaName,
            jobTitle,
            lineName,
            regionName: textOrNull(row.sent_for_region),
            vacancyId: numberOrNull(row.sent_for_vacancy_id),
          }
        : null,
    sentAt: String(row.sent_at ?? ""),
  };
}

/**
 * This manager's own send, in the shape the candidate card reads.
 *
 * WHY AN OVERLAY AND NOT JUST THE CANDIDATE ROW. The columns on ats_candidates hold whoever was
 * sent the CV LAST. Once a CV can go to two managers, rendering those columns shows manager A the
 * date, the seat and — worse — the VACANCY that manager B was sent it for, filing it in A's inbox
 * under a folder A never chose. Two managers being sent the same person for two different seats is
 * the ordinary case, not the edge one.
 *
 * Pure, and exported, so the substitution is testable without a database and cannot quietly drift
 * from what the page renders.
 */
export function managerSendStamp(send: ManagerSend): {
  managerNotified: {
    areaName: string | null;
    hrId: string;
    jobTitle: string | null;
    name: string;
    regionName: string | null;
    sentAt: string;
  };
  sentFor: SentForPosition | null;
} {
  return {
    managerNotified: {
      areaName: send.managerArea,
      hrId: send.managerHrId,
      jobTitle: send.managerJobTitle,
      // Never a bare HR_ID on a screen — the standing rule. Falls back to the id only when the send
      // was recorded without a resolvable name, which is strictly better than rendering nothing.
      name: send.managerName ?? send.managerHrId,
      regionName: send.managerRegion,
      sentAt: send.sentAt,
    },
    sentFor: send.position,
  };
}

/**
 * Record one manager's send of each candidate.
 *
 * Upserts on (candidate_id, lower(manager_hr_id)): re-sending the same CV to the same person moves
 * their existing row rather than stacking a duplicate in their list — a recruiter re-sending is
 * correcting or re-pointing, not asking for a second review.
 *
 * Returns false when the table is not there yet, so the caller can say the fan-out was skipped
 * rather than silently believing it happened.
 */
export async function recordManagerSends(input: {
  actorHrId: string | null;
  candidateIds: readonly string[];
  managerHrId: string;
  managerName: string | null;
  managerArea: string | null;
  managerJobTitle: string | null;
  managerRegion: string | null;
  position: SentForPosition | null;
  sentAt: string;
}): Promise<boolean> {
  if (input.candidateIds.length === 0) return true;
  // CANONICAL on the way in — the column stores lower case so that the uniqueness can be a plain
  // two-column index, which is the only kind PostgREST can name as an ON CONFLICT target. Falling
  // back to the raw value keeps a send recordable even for an id canonicalHrIdKey cannot parse;
  // the read matches either way, because hrIdLookupKeys yields both spellings.
  const managerKey = canonicalHrIdKey(input.managerHrId) ?? input.managerHrId.trim();
  if (!managerKey) throw new Error("recordManagerSends: a send needs a manager.");
  const supabase = recruitmentDb();

  for (const batch of chunkIds([...input.candidateIds])) {
    const rows = batch.map((candidateId) => ({
      candidate_id: candidateId,
      manager_area: input.managerArea,
      manager_hr_id: managerKey,
      manager_job_title: input.managerJobTitle,
      manager_name: input.managerName,
      manager_region: input.managerRegion,
      sent_at: input.sentAt,
      sent_by_hr_id: input.actorHrId,
      sent_for_area: input.position?.areaName ?? null,
      sent_for_job_title: input.position?.jobTitle ?? null,
      sent_for_line: input.position?.lineName ?? null,
      sent_for_region: input.position?.regionName ?? null,
      sent_for_vacancy_id: input.position?.vacancyId ?? null,
      updated_at: input.sentAt,
    }));

    const { error } = await supabase
      .from(MANAGER_SENDS_TABLE)
      // Matches ats_candidate_manager_sends_unique exactly. Both columns are plain, which is the
      // whole reason manager_hr_id is stored canonical: an index on lower(manager_hr_id) could not
      // be named here and the upsert would fail with "no unique or exclusion constraint matching".
      .upsert(rows, { onConflict: "candidate_id,manager_hr_id" });
    if (!error) continue;
    if (isMissingTable(error)) return false;
    throw error;
  }
  return true;
}

/**
 * Every send made to one manager, newest first.
 *
 * Returns null — distinct from an empty array — when the table is not there yet, so the caller can
 * tell "this database has no fan-out" from "nothing was sent to you". Conflating those is how a
 * manager gets shown an empty page that means the opposite of what it says.
 *
 * The HR_ID goes through hrIdLookupKeys rather than a bare .eq for the reason it does everywhere
 * else here: stored ids are MIXED CASE ('B-12', 'b-10', 'PD-0001'), PostgREST eq is case-sensitive,
 * and a filter matching nothing is indistinguishable from "nothing was sent to you".
 */
export async function listSendsForManager(managerHrId: string | null | undefined): Promise<ManagerSend[] | null> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0) return [];

  const { data, error } = await recruitmentDb()
    .from(MANAGER_SENDS_TABLE)
    .select("candidate_id,manager_hr_id,manager_name,manager_area,manager_job_title,manager_region,sent_for_area,sent_for_job_title,sent_for_line,sent_for_region,sent_for_vacancy_id,sent_at")
    .in("manager_hr_id", keys)
    .order("sent_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return ((data ?? []) as SendDbRow[]).map(mapSend).filter((send) => send.candidateId.length > 0);
}

/**
 * Has this candidate been sent to this manager?
 *
 * This answers the ACCESS question, not the display one, and it is a separate question from
 * listSendsForManager because opening a CV goes through its own scope check on a different route.
 * That check read ats_candidates.manager_notified_hr_id — the column that holds only the LAST
 * manager — so the moment a CV went to a second person the first was refused the file, while still
 * seeing the name in their list. Salim Salim Abdo Ibrahim Gomaa is the live case: his send was
 * restored into this table on 2026-08-30, and the candidate row still names Hany Saad Mohamed Omar.
 * Without this, he opens his list, sees Sara Osama AbdAlfattah, clicks, and is told she is outside
 * his scope.
 *
 * Returns null when the table is not there yet — distinct from false — so a caller can keep the old
 * column's answer instead of turning a missing migration into a denied CV.
 */
export async function isCandidateSentToManager(
  candidateId: string,
  managerHrId: string | null | undefined,
): Promise<boolean | null> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0 || !candidateId) return false;

  const { data, error } = await recruitmentDb()
    .from(MANAGER_SENDS_TABLE)
    .select("candidate_id")
    .eq("candidate_id", candidateId)
    .in("manager_hr_id", keys)
    .limit(1);

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return (data ?? []).length > 0;
}
