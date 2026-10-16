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
import { loadFolderHolderKeys, managerHoldsFolders } from "@/lib/recruitment/folder-holders";
import { isWithinManagerHold, managerHoldCutoffIso } from "@/lib/recruitment/manager-hold-window";
import { managerLabel } from "@/lib/recruitment/person-labels";
import type { SentForPosition } from "@/lib/recruitment/types";

/** The table, named once so a rename is one edit and a typo cannot half-apply. */
export const MANAGER_SENDS_TABLE = "ats_candidate_manager_sends";

/**
 * Every column `mapSend` reads, named once for the same reason the table is.
 *
 * It was spelled out separately at each read, and a column missing from one of those lists does not
 * fail — `mapSend` simply maps it to null, so one reader silently loses the manager's seat or the
 * vacancy while its siblings keep it.
 */
/** PostgREST serves at most this many rows for one request, so a whole-table read must page. */
const SEND_PAGE_SIZE = 1000;

/** A runaway guard, not a data cap: 50 pages is 50,000 recorded sends. */
const SEND_PAGE_LIMIT = 50;

const SEND_COLUMNS =
  "candidate_id,manager_hr_id,manager_name,manager_area,manager_job_title,manager_region,sent_for_area,sent_for_job_title,sent_for_line,sent_for_region,sent_for_vacancy_id,sent_at";

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
      // Never a bare HR_ID on a screen — the standing rule. This fell back to the id when the send
      // was recorded without a resolvable name, on the reasoning that an id beats an empty space. It
      // does, and words beat both: "Unnamed manager" is something the reader can act on, and it is
      // what every other recruitment surface now says.
      name: managerLabel(send.managerName),
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
 *
 * ONLY THE SENDS STILL INSIDE THEIR 45 DAYS (manager-hold-window.ts) — EXCEPT FOR A MANAGER WHO HOLDS
 * FOLDERS, whose sends carry no limit (owner, 2026-10-16: "lift it"). A send older than that is not
 * deleted — it stays on the trail, and the timeline and the screening queue still read it — it just
 * stops being something this manager can see or open. `now` is a parameter so a test can pin it.
 */
export async function listSendsForManager(
  managerHrId: string | null | undefined,
  now: Date = new Date(),
): Promise<ManagerSend[] | null> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0) return [];

  let query = recruitmentDb().from(MANAGER_SENDS_TABLE).select(SEND_COLUMNS).in("manager_hr_id", keys);
  if (!(await managerHoldsFolders(managerHrId))) query = query.gte("sent_at", managerHoldCutoffIso(now));
  const { data, error } = await query.order("sent_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return ((data ?? []) as SendDbRow[]).map(mapSend).filter((send) => send.candidateId.length > 0);
}

/**
 * Every send of ONE candidate, newest first — the manager half of that person's timeline.
 *
 * The candidate row carries only the LAST send, so a CV that went to Tanta and then to Mansoura
 * reads on the row as though Tanta never happened. That is correct for the row (it answers "where
 * is this now") and wrong for a history, which is exactly the thing the timeline exists to show.
 *
 * Returns an empty list rather than null when the table is missing: this feeds one section of a
 * side panel, and a panel that refuses to render is worse than a panel that is honestly short.
 */
export async function listSendsForCandidate(candidateId: string): Promise<ManagerSend[]> {
  const id = String(candidateId ?? "").trim();
  if (!id) return [];

  const { data, error } = await recruitmentDb()
    .from(MANAGER_SENDS_TABLE)
    .select(SEND_COLUMNS)
    .eq("candidate_id", id)
    .order("sent_at", { ascending: false });

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
  return ((data ?? []) as SendDbRow[]).map(mapSend).filter((send) => send.sentAt.length > 0);
}

/**
 * The NEWEST send of each of these candidates, keyed by candidate id.
 *
 * WHY A THIRD READER. The screening queue asks one question of a whole pool at once — "which of
 * these is sitting with a manager, since when?" — and it was answering it from the candidate row's
 * own `manager_notified_*` columns alone. Those columns are the pre-2026-08-30 single-manager
 * record. `listCandidatesSentToManager` already unions both sources because reading either alone
 * has a window where it is wrong; the screening side never got that treatment, and production shows
 * both halves of the gap it leaves:
 *
 *   • MOAAZ MOUSTAFA AHMED ELSAYED ABDELHAFEZ — a send row to Saad Salama dated 31 Aug 2026 with
 *     both candidate columns NULL. He is not in the Manager-feedback pile at all, is not counted as
 *     overdue, is missed by `?sent=1` and is wrongly returned by `?unsent=1` — five days after the
 *     send, on a screen whose job is to chase exactly that.
 *   • Mohamed Ramadan Khalaf — sent to Ali Moh Ali on 30 Aug, re-sent to Dr Anwar Gaweesh on
 *     1 Sep. The candidate row still names the FIRST, so the queue ages him from the wrong send and
 *     shows the wrong manager.
 *
 * NEWEST, not all of them, and that is the shape the caller needs rather than a shortcut: the row
 * answers "where is this CV now, and how long has it been there". The full trail is
 * `listSendsForCandidate`, which the timeline already renders.
 *
 * THE WHOLE TABLE, not a filtered `.in()` on the caller's ids. Its only caller is listCandidates,
 * which loads the entire pool anyway, so filtering by id would trade ONE request for eight (744 ids
 * at db-batch.ts's 100 per batch) to fetch a table holding 72 rows. Paged all the same: PostgREST
 * caps a request at 1000 rows and says nothing, and a send silently missing from this map reads as
 * "never sent", which is the exact failure the map exists to end.
 *
 * Returns null — distinct from an empty map — when the table is not there yet, so the caller keeps
 * the old columns' answer instead of turning a missing migration into "nothing was ever sent".
 */
export async function listLatestSendByCandidate(): Promise<Map<string, ManagerSend> | null> {
  const latest = new Map<string, ManagerSend>();
  const supabase = recruitmentDb();

  for (let page = 0; page < SEND_PAGE_LIMIT; page += 1) {
    const from = page * SEND_PAGE_SIZE;
    const { data, error } = await supabase
      .from(MANAGER_SENDS_TABLE)
      .select(SEND_COLUMNS)
      // A stable, unique order. `.range()` without one is served in whatever order the planner chose
      // for THAT request, so page two can repeat page one and omit rows — losing sends with no error.
      .order("candidate_id", { ascending: true })
      .order("manager_hr_id", { ascending: true })
      .range(from, from + SEND_PAGE_SIZE - 1);

    if (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }

    for (const send of ((data ?? []) as SendDbRow[]).map(mapSend)) {
      if (!send.candidateId || !send.sentAt) continue;
      const held = latest.get(send.candidateId);
      // Compared as INSTANTS, not as strings. Both are `timestamp with time zone` today, so the
      // two spellings match — but a column added later as a plain `timestamp` renders without the
      // offset, and "2026-09-01T10:20:57.147" sorts BELOW "2026-08-29T22:42:45.734+00:00" on a
      // string compare, which would silently pick the older send as the newer one.
      if (held && !isAfter(send.sentAt, held.sentAt)) continue;
      latest.set(send.candidateId, send);
    }

    if ((data ?? []).length < SEND_PAGE_SIZE) return latest;
  }

  throw new Error(
    `Manager-send paging stopped at ${SEND_PAGE_LIMIT * SEND_PAGE_SIZE} rows. Refusing to report a sent CV as never sent.`,
  );
}

/**
 * Is `candidate` strictly later than `than`? Unparseable on either side answers false.
 *
 * Exported so listCandidates' overlay compares its two stamps exactly the way this module picks a
 * winner — two copies of "which of these is newer" is two places for the answer to differ.
 */
export function isAfter(candidate: string | null | undefined, than: string | null | undefined): boolean {
  const left = Date.parse(String(candidate ?? ""));
  const right = Date.parse(String(than ?? ""));
  if (!Number.isFinite(left)) return false;
  if (!Number.isFinite(right)) return true;
  return left > right;
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
 *
 * A SEND OLDER THAN 45 DAYS ANSWERS FALSE, the same cutoff `listSendsForManager` applies, so the
 * CV that fell off his list cannot still be opened by guessing its id (manager-hold-window.ts). A
 * manager who holds folders has no cutoff, here as there.
 */
export async function isCandidateSentToManager(
  candidateId: string,
  managerHrId: string | null | undefined,
  now: Date = new Date(),
): Promise<boolean | null> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0 || !candidateId) return false;

  let query = recruitmentDb()
    .from(MANAGER_SENDS_TABLE)
    .select("candidate_id")
    .eq("candidate_id", candidateId)
    .in("manager_hr_id", keys);
  if (!(await managerHoldsFolders(managerHrId))) query = query.gte("sent_at", managerHoldCutoffIso(now));
  const { data, error } = await query.limit(1);

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  return (data ?? []).length > 0;
}

/**
 * Every send in the table, newest first — what the folders and the reminder run are built from.
 *
 * `withinHold` applies the same 45-day cutoff the manager's own list does — and, like it, to nobody who
 * holds folders. The reminder run wants it; the engagement report does not, because a CV that aged out of an
 * account was still received. Paged for the reason `listLatestSendByCandidate` is: PostgREST stops at
 * 1000 rows without saying so, and a send missing from this list reads as "never sent".
 *
 * Returns null — distinct from an empty list — when the table is not in this database yet.
 */
export async function listAllManagerSends(
  options: { now?: Date; withinHold?: boolean } = {},
): Promise<ManagerSend[] | null> {
  const supabase = recruitmentDb();
  const sends: ManagerSend[] = [];
  const now = options.now ?? new Date();
  const holders = options.withinHold ? await loadFolderHolderKeys() : null;

  for (let page = 0; page < SEND_PAGE_LIMIT; page += 1) {
    const from = page * SEND_PAGE_SIZE;
    const { data, error } = await supabase
      .from(MANAGER_SENDS_TABLE)
      .select(SEND_COLUMNS)
      .order("candidate_id", { ascending: true })
      .order("manager_hr_id", { ascending: true })
      .range(from, from + SEND_PAGE_SIZE - 1);
    if (error) {
      if (isMissingTable(error)) return null;
      throw error;
    }
    sends.push(
      ...((data ?? []) as SendDbRow[])
        .map(mapSend)
        .filter((send) => send.candidateId && send.sentAt)
        .filter(
          (send) =>
            !holders || holders.has(canonicalHrIdKey(send.managerHrId) ?? "") || isWithinManagerHold(send.sentAt, now),
        ),
    );
    if ((data ?? []).length < SEND_PAGE_SIZE) return sends;
  }

  throw new Error(
    `Manager-send paging stopped at ${SEND_PAGE_LIMIT * SEND_PAGE_SIZE} rows. Refusing to report a short list of sends.`,
  );
}

/**
 * Take one CV back out of one manager's folders: delete the (candidate, manager) send row.
 *
 * Returns whether a row was there to delete. The caller (`recallCandidateFromManager`) owns
 * everything around it — the legacy stamp and the candidate's status — because those are decisions
 * about the CV, and this file only knows about sends.
 */
export async function deleteManagerSend(candidateId: string, managerHrId: string): Promise<boolean> {
  const keys = hrIdLookupKeys(managerHrId);
  if (keys.length === 0 || !candidateId) return false;
  const { data, error } = await recruitmentDb()
    .from(MANAGER_SENDS_TABLE)
    .delete()
    .eq("candidate_id", candidateId)
    .in("manager_hr_id", keys)
    .select("candidate_id");
  if (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }
  return (data ?? []).length > 0;
}
