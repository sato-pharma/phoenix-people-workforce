// Recruitment workspace — the rows, the counts and the answer filters, read for one viewer.
//
// THE DATABASE DECIDES WHICH ROWS; THIS FILE ONLY DRESSES THEM. `ats_workspace_page` and
// `ats_workspace_counts` both run `ats_workspace_filter`, which applies every filter, the viewer's
// allowed tabs and the Talent Acquisition fence in one place. Nothing here filters a row out after
// the fact — a row decoration that dropped people would make the page and the tab badge disagree,
// and a fence applied twice in two languages is a fence that will one day differ. The allowed tabs
// and the fence come from the SESSION (`workspaceDbParams` takes the viewer), never from the request.
//
// DECORATED PER PAGE, NEVER PER POOL. A page is at most 200 ids; every decoration is one batched read
// keyed on those ids, run in parallel. The two exceptions are reads whose whole-table form is the
// cheaper one: the duplicate flag (a person's twin may be on another page, so it must see the pool —
// a slim three-column read) and the latest manager send (`listLatestSendByCandidate`, a table of a
// few dozen rows that its own header explains). The export loads those once and reuses them.
//
// EVERY READ ERROR THROWS. A decoration that failed quietly would draw a row with no flag, which on
// this screen means "nothing to chase" — the exact lie the flags exist to prevent.
//
// The CV-text half of the search box is `workspaceCvSearchIds` (search.ts); a search with no tab
// chosen looks across every tab the viewer can see (owner, 20 Oct 2026: one search box, "across
// every tab"), so the UI sends no `tab` while searching everywhere.

import { candidateRegionLabels, type CandidateRegionCode } from "@/lib/recruitment/candidate-region";
import { findDuplicateFlags, normalizeNameForMatch, phoneTailForMatch } from "@/lib/recruitment/candidate-matching";
import { DEFAULT_CANDIDATE_STATUS, normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { collectCvFolderSubtreeIds, type CvFolderRow } from "@/lib/recruitment/cv-folder-tree";
import { fetchRowsInBatches } from "@/lib/recruitment/db-batch";
import { recruitmentDb, textOrNull } from "@/lib/recruitment/db";
import { listLatestSendByCandidate, type ManagerSend } from "@/lib/recruitment/manager-sends";
import { namesByHrId, type EmployeeNameIndex } from "@/lib/employees/names-by-hr-id";
import { isUuid } from "@/lib/http/uuid";
import { fetchAllRowsKeyset } from "@/lib/supabase/paginated";
import {
  answerChipsFor,
  answerMarkHrIds,
  buildAnswerFilters,
  familiesForTab,
  filterableAnswerKeys,
  loadAnswerChipContext,
  type AnswerChipContext,
  type StoredAnswerValues,
} from "@/lib/recruitment/workspace/answer-chips";
import {
  emptyWorkspaceFilters,
  workspaceDbParams,
  type WorkspaceDbParams,
  type WorkspaceFilters,
} from "@/lib/recruitment/workspace/filters";
import { emptyWorkspaceCounts, mapWorkspaceCounts } from "@/lib/recruitment/workspace/funnel";
import { workspaceOverdue } from "@/lib/recruitment/workspace/overdue";
import { listPlacementsFor, type PlacementRecord } from "@/lib/recruitment/workspace/placements-db";
import {
  allowedTabsForViewer,
  isWorkspaceRoleTab,
  NEEDS_PLACING,
  personVisibleToViewer,
  type WorkspaceTabKey,
  type WorkspaceViewer,
} from "@/lib/recruitment/workspace/role-tabs";
import { workspaceCvSearchIds } from "@/lib/recruitment/workspace/search";
import type {
  WorkspaceAnswerFilter,
  WorkspaceCounts,
  WorkspaceCursor,
  WorkspacePage,
  WorkspacePlacement,
  WorkspaceRow,
} from "@/lib/recruitment/workspace/types";
import {
  candidateSourceKey,
  isCallResult,
  isRejectionReason,
  type CallResult,
} from "@/lib/recruitment/workspace/vocabulary";

/** One page's default and ceiling — the ceiling is `ats_workspace_page`'s own. */
export const WORKSPACE_PAGE_DEFAULT = 50;
export const WORKSPACE_PAGE_MAX = 200;
/** The export's default ceiling. A tab holds a few hundred people; this is every realistic export. */
export const WORKSPACE_EXPORT_DEFAULT_MAX = 5000;
/** How many people's stored answers feed the answer-filter lists. */
const ANSWER_VALUES_MAX_IDS = 2000;

/** Only the reply columns, the identity line and the flags. Never a CV-reading column. */
const CANDIDATE_COLUMNS = [
  "id",
  "full_name",
  "phone",
  "email",
  "source",
  "created_at",
  "status",
  "status_changed_at",
  "offer_id",
  "declared_role_family",
  "applied_for_job_title",
  "preferences_declared_at",
  "declared_background",
  "declared_experience",
  "declared_expected_salary",
  "preferred_region_code",
  "preferred_region_name",
  "preferred_area_name",
  "screening_extra_answers",
  "answer_marks",
  "rejection_reason",
  "rejection_reason_note",
  "archived_at",
  "answers_expected",
  "answers_given",
  "missing_answer_keys",
].join(",");

type CandidateRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  created_at: string;
  status: string | null;
  status_changed_at: string | null;
  offer_id: string | null;
  declared_role_family: string | null;
  applied_for_job_title: string | null;
  preferences_declared_at: string | null;
  declared_background: string | null;
  declared_experience: string | null;
  declared_expected_salary: string | null;
  preferred_region_code: string | null;
  preferred_region_name: string | null;
  preferred_area_name: string | null;
  screening_extra_answers: Record<string, unknown> | null;
  answer_marks: Record<string, unknown> | null;
  rejection_reason: string | null;
  rejection_reason_note: string | null;
  archived_at: string | null;
  answers_expected: number | null;
  answers_given: number | null;
  missing_answer_keys: string[] | null;
};

type PoolPerson = { id: string; full_name: string | null; phone_norm: string | null; declared_role_family: string | null };

// ---------------------------------------------------------------------------------------------
// Filters -> the database's p
// ---------------------------------------------------------------------------------------------

/** Folder ids with every subfolder beneath them — "a folder holds what its subfolders hold". */
async function expandFolderIds(folderIds: readonly string[]): Promise<string[]> {
  if (folderIds.length === 0) return [];
  const { data, error } = await recruitmentDb()
    .from("ats_cv_folders")
    .select("id,parent_id,name,created_at,created_by_hr_id");
  if (error) throw error;
  const rows: CvFolderRow[] = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    createdAt: String(row.created_at ?? ""),
    createdByHrId: textOrNull(row.created_by_hr_id),
    id: String(row.id),
    name: String(row.name ?? ""),
    parentId: textOrNull(row.parent_id),
  }));
  const ids = new Set<string>();
  for (const folderId of folderIds) for (const id of collectCvFolderSubtreeIds(rows, folderId)) ids.add(id);
  return [...ids];
}

/** True when the search looks across every tab: a search with no tab chosen. */
function searchesEverywhere(filters: WorkspaceFilters): boolean {
  return Boolean(filters.search) && filters.tab === null;
}

/** The `p` for these filters and this viewer, with the CV-text matches and the folder subtree resolved. */
export async function resolveWorkspaceParams(filters: WorkspaceFilters, viewer: WorkspaceViewer): Promise<WorkspaceDbParams> {
  const [searchIds, folderIdsExpanded] = await Promise.all([
    filters.search ? workspaceCvSearchIds(viewer, filters.search) : Promise.resolve([] as string[]),
    expandFolderIds(filters.folderIds),
  ]);
  return workspaceDbParams(filters, viewer, {
    folderIdsExpanded,
    scope: searchesEverywhere(filters) ? "all" : "tab",
    searchIds,
  });
}

/** The tab the rows are being viewed in — the one whose questions the chips follow. Null across tabs. */
export function viewedTab(filters: WorkspaceFilters, viewer: WorkspaceViewer): WorkspaceTabKey | null {
  if (searchesEverywhere(filters)) return null;
  if (filters.tab) return filters.tab;
  const first = allowedTabsForViewer(viewer)[0];
  return (first as WorkspaceTabKey | undefined) ?? NEEDS_PLACING;
}

type PageRef = { candidate_id: string; created_at: string };

async function workspacePageRefs(p: WorkspaceDbParams): Promise<PageRef[]> {
  const { data, error } = await recruitmentDb().rpc("ats_workspace_page", { p });
  if (error) throw error;
  return ((data ?? []) as Array<{ candidate_id?: string | null; created_at?: string | null }>)
    .map((row) => ({ candidate_id: String(row.candidate_id ?? ""), created_at: String(row.created_at ?? "") }))
    .filter((row) => row.candidate_id.length > 0);
}

/** Every matching id, newest first, by keyset pages of 200, up to `max`. */
async function collectWorkspaceIds(p: WorkspaceDbParams, max: number): Promise<string[]> {
  const ids: string[] = [];
  let after: WorkspaceCursor | null = null;
  while (ids.length < max) {
    const refs = await workspacePageRefs({
      ...p,
      ...(after ? { after: { created_at: after.createdAt, id: after.id } } : {}),
      limit: WORKSPACE_PAGE_MAX,
    });
    for (const ref of refs) ids.push(ref.candidate_id);
    if (refs.length < WORKSPACE_PAGE_MAX) break;
    const last = refs[refs.length - 1];
    after = { createdAt: last.created_at, id: last.candidate_id };
  }
  return ids.slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// Decoration
// ---------------------------------------------------------------------------------------------

/** The reads that are the same for every page — loaded once per request, reused by the export. */
type SharedDecorations = {
  chipContext: AnswerChipContext;
  pool: PoolPerson[];
  latestSends: Map<string, ManagerSend> | null;
};

async function loadSharedDecorations(): Promise<SharedDecorations> {
  const [chipContext, pool, latestSends] = await Promise.all([
    loadAnswerChipContext(),
    fetchAllRowsKeyset<PoolPerson>(
      () => recruitmentDb().from("ats_candidates").select("id,full_name,phone_norm,declared_role_family"),
      { cursorColumn: "id", cursorOf: (row) => row.id },
    ),
    listLatestSendByCandidate(),
  ]);
  return { chipContext, latestSends, pool };
}

type DuplicateIndex = { flagged: Map<string, { reason: string; otherIds: string[] }> };

/**
 * The possible-duplicate badge, by the pool's own advisory rule (`findDuplicateFlags`: a shared phone
 * tail first, else a shared name). It names every other record sharing that key, not only the first,
 * and for a fenced viewer names only the records she may see — a twin she cannot see is no badge.
 */
async function duplicatesFor(
  pageIds: readonly string[],
  pool: readonly PoolPerson[],
  viewer: WorkspaceViewer,
): Promise<DuplicateIndex> {
  const flags = findDuplicateFlags(pool.map((person) => ({ fullName: person.full_name, id: person.id, phoneNorm: person.phone_norm })));
  const byTail = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const personById = new Map(pool.map((person) => [person.id, person]));
  for (const person of pool) {
    const tail = phoneTailForMatch(person.phone_norm);
    if (tail) (byTail.get(tail) ?? byTail.set(tail, []).get(tail)!).push(person.id);
    const name = normalizeNameForMatch(person.full_name);
    if (name) (byName.get(name) ?? byName.set(name, []).get(name)!).push(person.id);
  }

  const raw = new Map<string, { reason: string; otherIds: string[] }>();
  for (const id of pageIds) {
    const flag = flags.get(id);
    const person = personById.get(id);
    if (!flag || !person) continue;
    const others =
      flag.reason === "phone_tail"
        ? (byTail.get(phoneTailForMatch(person.phone_norm) ?? "") ?? [])
        : (byName.get(normalizeNameForMatch(person.full_name) ?? "") ?? []);
    raw.set(id, {
      otherIds: others.filter((other) => other !== id),
      reason: flag.reason === "phone_tail" ? "Same phone number" : "Same name",
    });
  }

  if (!viewer.hidesHrPeople) return { flagged: raw };
  const otherIds = [...new Set([...raw.values()].flatMap((entry) => entry.otherIds))];
  const placements = await listPlacementsFor(otherIds);
  const visible = new Set(
    otherIds.filter((other) =>
      personVisibleToViewer(viewer, {
        declaredRoleFamily: personById.get(other)?.declared_role_family ?? null,
        placementTabs: (placements.get(other) ?? []).map((placement) => placement.roleTab),
      }),
    ),
  );
  const flagged = new Map<string, { reason: string; otherIds: string[] }>();
  for (const [id, entry] of raw) {
    const shown = entry.otherIds.filter((other) => visible.has(other));
    if (shown.length > 0) flagged.set(id, { otherIds: shown, reason: entry.reason });
  }
  return { flagged };
}

function latestBy<T>(rows: readonly T[], idOf: (row: T) => string, timeOf: (row: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const row of rows) {
    const id = idOf(row);
    const held = out.get(id);
    if (!held || Date.parse(timeOf(row)) > Date.parse(timeOf(held))) out.set(id, row);
  }
  return out;
}

type CallRow = { candidate_id: string; result: string; note: string | null; hr_id: string | null; created_at: string };
type ReturnRow = {
  candidate_id: string;
  returned_at: string;
  returned_by_hr_id: string | null;
  returned_by_name: string | null;
  reason_code: string | null;
  reason_note: string | null;
  source: string;
};
type BookingRow = { id: string; candidate_id: string; starts_at: string; outcome: string | null };
type FolderItemRow = { candidate_id: string; folder_id: string };

/** The family whose questions a candidate is expected to answer, in the tab being viewed. */
function chipRoleFamily(tab: WorkspaceTabKey | null, candidate: CandidateRow, placements: readonly PlacementRecord[]): string | null {
  if (tab && isWorkspaceRoleTab(tab)) {
    const here = placements.find((placement) => placement.roleTab === tab);
    if (here?.botRoleFamily) return here.botRoleFamily;
    const families = familiesForTab(tab) ?? [];
    // HR filed them by hand with no tapped family: a one-family tab says which; a shared tab
    // (RM/AM + NSM, Other) falls back to what they declared.
    if (families.length === 1) return families[0];
    return candidate.declared_role_family ?? null;
  }
  return candidate.declared_role_family ?? placements.find((placement) => placement.botRoleFamily)?.botRoleFamily ?? null;
}

function regionName(code: string | null): string | null {
  if (!code) return null;
  return candidateRegionLabels[code as CandidateRegionCode] ?? null;
}

/** One placement as the screen shows it: the region's name, and who filed it by name, never a code. */
export function toWorkspacePlacement(placement: PlacementRecord, nameOf: (hrId: string) => string | null): WorkspacePlacement {
  return {
    areaCode: placement.areaCode,
    areaName: placement.areaName,
    botRoleFamily: placement.botRoleFamily,
    placedAt: placement.placedAt,
    placedBy: placement.placedBy,
    placedByName: placement.placedByHrId ? nameOf(placement.placedByHrId) : null,
    regionCode: placement.regionCode,
    regionName: regionName(placement.regionCode),
    tab: placement.roleTab,
  };
}

async function decorateRows(
  ids: readonly string[],
  context: { tab: WorkspaceTabKey | null; viewer: WorkspaceViewer; shared: SharedDecorations },
): Promise<WorkspaceRow[]> {
  if (ids.length === 0) return [];
  const db = recruitmentDb();
  const list = [...ids];

  const [candidates, placements, duplicates, calls, returns, bookings, folderItems, cvFiles] = await Promise.all([
    fetchRowsInBatches<CandidateRow>(list, (batch) => db.from("ats_candidates").select(CANDIDATE_COLUMNS).in("id", batch).returns<CandidateRow[]>()),
    listPlacementsFor(list),
    duplicatesFor(list, context.shared.pool, context.viewer),
    fetchRowsInBatches<CallRow>(list, (batch) =>
      db.from("ats_candidate_call_results").select("candidate_id,result,note,hr_id,created_at").in("candidate_id", batch),
    ),
    fetchRowsInBatches<ReturnRow>(list, (batch) =>
      db
        .from("ats_v_candidate_returns")
        .select("candidate_id,returned_at,returned_by_hr_id,returned_by_name,reason_code,reason_note,source")
        .in("candidate_id", batch),
    ),
    fetchRowsInBatches<BookingRow>(list, (batch) =>
      db.from("ats_interview_bookings").select("id,candidate_id,starts_at,outcome").in("candidate_id", batch),
    ),
    fetchRowsInBatches<FolderItemRow>(list, (batch) =>
      db.from("ats_cv_folder_items").select("candidate_id,folder_id").in("candidate_id", batch),
    ),
    fetchRowsInBatches<{ candidate_id: string }>(list, (batch) =>
      db.from("ats_files").select("candidate_id").eq("kind", "cv").in("candidate_id", batch),
    ),
  ]);

  const folderIds = [...new Set(folderItems.map((item) => item.folder_id))];
  const folderNames = new Map<string, string>();
  if (folderIds.length > 0) {
    const folders = await fetchRowsInBatches<{ id: string; name: string | null }>(folderIds, (batch) =>
      db.from("ats_cv_folders").select("id,name").in("id", batch),
    );
    for (const folder of folders) folderNames.set(folder.id, String(folder.name ?? ""));
  }

  const latestCall = latestBy(calls, (row) => row.candidate_id, (row) => row.created_at);
  const returnBy = new Map(returns.map((row) => [row.candidate_id, row]));
  const latestBooking = latestBy(bookings, (row) => row.candidate_id, (row) => row.starts_at);
  const hasCv = new Set(cvFiles.map((row) => row.candidate_id));
  const foldersBy = new Map<string, { id: string; name: string }[]>();
  for (const item of folderItems) {
    const name = folderNames.get(item.folder_id);
    if (name === undefined) continue;
    const held = foldersBy.get(item.candidate_id) ?? [];
    if (!held.some((folder) => folder.id === item.folder_id)) held.push({ id: item.folder_id, name });
    foldersBy.set(item.candidate_id, held);
  }

  const hrIds = new Set<string>();
  for (const candidate of candidates) for (const id of answerMarkHrIds(candidate.answer_marks)) hrIds.add(id);
  for (const call of latestCall.values()) if (call.hr_id) hrIds.add(call.hr_id);
  for (const back of returnBy.values()) if (!back.returned_by_name && back.returned_by_hr_id) hrIds.add(back.returned_by_hr_id);
  for (const rows of placements.values()) for (const placement of rows) if (placement.placedByHrId) hrIds.add(placement.placedByHrId);
  const names: EmployeeNameIndex = await namesByHrId(hrIds);

  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const rows: WorkspaceRow[] = [];
  for (const id of list) {
    const candidate = byId.get(id);
    if (!candidate) continue; // deleted between the page read and this one
    const own = placements.get(id) ?? [];
    const status = normalizeCandidateStatus(candidate.status) ?? DEFAULT_CANDIDATE_STATUS;
    const send = context.shared.latestSends?.get(id) ?? null;
    const call = latestCall.get(id);
    const back = returnBy.get(id);
    const booking = latestBooking.get(id);
    const duplicate = duplicates.flagged.get(id);

    const placementsOut = own.map((placement) => toWorkspacePlacement(placement, (hrId) => names.get(hrId)));

    rows.push({
      answers: answerChipsFor(
        {
          answerMarks: candidate.answer_marks,
          appliedForJobTitle: candidate.applied_for_job_title,
          declaredBackground: candidate.declared_background,
          declaredExpectedSalary: candidate.declared_expected_salary,
          declaredExperience: candidate.declared_experience,
          declaredRoleFamily: candidate.declared_role_family,
          preferencesDeclaredAt: candidate.preferences_declared_at,
          preferredAreaName: candidate.preferred_area_name,
          preferredRegionCode: candidate.preferred_region_code,
          preferredRegionName: candidate.preferred_region_name,
          screeningExtraAnswers: candidate.screening_extra_answers,
        },
        {
          context: context.shared.chipContext,
          missingKeys: Array.isArray(candidate.missing_answer_keys) ? candidate.missing_answer_keys : null,
          nameOf: (hrId) => names.get(hrId),
          roleFamily: chipRoleFamily(context.tab, candidate, own),
          tab: context.tab,
        },
      ),
      archivedAt: candidate.archived_at,
      completeness:
        candidate.answers_expected !== null && candidate.answers_given !== null
          ? {
              expected: candidate.answers_expected,
              given: candidate.answers_given,
              missingKeys: Array.isArray(candidate.missing_answer_keys) ? candidate.missing_answer_keys : [],
            }
          : null,
      duplicate: duplicate ? { otherCandidateIds: duplicate.otherIds, reason: duplicate.reason } : null,
      email: textOrNull(candidate.email),
      folders: foldersBy.get(id) ?? [],
      hasCvFile: hasCv.has(id),
      id,
      interview: booking ? { bookingId: booking.id, outcome: booking.outcome, startsAt: booking.starts_at } : null,
      latestCall:
        call && isCallResult(call.result)
          ? { at: call.created_at, byName: call.hr_id ? names.get(call.hr_id) : null, note: call.note, result: call.result as CallResult }
          : null,
      latestSend: send ? { managerHrId: send.managerHrId, managerName: send.managerName, sentAt: send.sentAt } : null,
      name: textOrNull(candidate.full_name) ?? "Name not given",
      offerId: candidate.offer_id,
      overdue: workspaceOverdue({
        createdAt: candidate.created_at,
        latestSentAt: send?.sentAt ?? null,
        status,
        statusChangedAt: candidate.status_changed_at,
      }),
      phone: textOrNull(candidate.phone),
      placements: placementsOut,
      receivedAt: candidate.created_at,
      rejection:
        status === "rejected"
          ? {
              note: candidate.rejection_reason_note,
              reason: isRejectionReason(candidate.rejection_reason) ? candidate.rejection_reason : null,
            }
          : null,
      returned: back
        ? {
            at: back.returned_at,
            byName: back.returned_by_name ?? (back.returned_by_hr_id ? names.get(back.returned_by_hr_id) : null),
            note: back.reason_note,
            reasonCode: back.reason_code,
            source: back.source,
          }
        : null,
      source: candidateSourceKey(candidate.source),
      status,
      statusChangedAt: candidate.status_changed_at,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// The public reads
// ---------------------------------------------------------------------------------------------

function cleanIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => String(id ?? "").trim()).filter((id) => isUuid(id)))].slice(0, WORKSPACE_PAGE_MAX);
}

/**
 * One page of rows, newest received first.
 *
 * `ids` reads exactly those people instead — the screen refreshing the rows it just acted on. The
 * filters are ignored then (a row that no longer matches them must still come back, changed), but the
 * viewer's allowed tabs and the fence still apply, archived people included.
 */
export async function loadWorkspacePage(
  filters: WorkspaceFilters,
  viewer: WorkspaceViewer,
  options: { after?: WorkspaceCursor | null; limit?: number; ids?: string[] } = {},
): Promise<WorkspacePage> {
  if (!viewer.canRead) return { nextCursor: null, rows: [] };
  const limit = Math.min(Math.max(Math.floor(options.limit ?? WORKSPACE_PAGE_DEFAULT), 1), WORKSPACE_PAGE_MAX);

  let p: WorkspaceDbParams;
  if (options.ids) {
    const ids = cleanIds(options.ids);
    if (ids.length === 0) return { nextCursor: null, rows: [] };
    p = workspaceDbParams({ ...emptyWorkspaceFilters(), archived: "include" }, viewer, { candidateIds: ids, scope: "all" });
  } else {
    p = await resolveWorkspaceParams(filters, viewer);
  }
  p.limit = limit;
  if (options.after) p.after = { created_at: options.after.createdAt, id: options.after.id };

  const [refs, shared] = await Promise.all([workspacePageRefs(p), loadSharedDecorations()]);
  const tab = options.ids ? (filters.tab ?? null) : viewedTab(filters, viewer);
  const rows = await decorateRows(
    refs.map((ref) => ref.candidate_id),
    { shared, tab, viewer },
  );
  const last = refs[refs.length - 1];
  return {
    nextCursor: refs.length === limit && last ? { createdAt: last.created_at, id: last.candidate_id } : null,
    rows,
  };
}

/** Every count the screen shows, from the same filter the rows come from. */
export async function loadWorkspaceCounts(filters: WorkspaceFilters, viewer: WorkspaceViewer): Promise<WorkspaceCounts> {
  if (!viewer.canRead) return emptyWorkspaceCounts();
  const p = await resolveWorkspaceParams(filters, viewer);
  const { data, error } = await recruitmentDb().rpc("ats_workspace_counts", { p });
  if (error) throw error;
  return mapWorkspaceCounts(data);
}

/** Every row the filters return, decorated, up to `max` — for the XLSX. Shared reads are made once. */
export async function loadWorkspaceRowsForExport(
  filters: WorkspaceFilters,
  viewer: WorkspaceViewer,
  options: { max?: number } = {},
): Promise<WorkspaceRow[]> {
  if (!viewer.canRead) return [];
  const max = Math.max(1, Math.floor(options.max ?? WORKSPACE_EXPORT_DEFAULT_MAX));
  const p = await resolveWorkspaceParams(filters, viewer);
  const [ids, shared] = await Promise.all([collectWorkspaceIds(p, max), loadSharedDecorations()]);
  const tab = viewedTab(filters, viewer);
  const rows: WorkspaceRow[] = [];
  for (let start = 0; start < ids.length; start += WORKSPACE_PAGE_MAX) {
    rows.push(...(await decorateRows(ids.slice(start, start + WORKSPACE_PAGE_MAX), { shared, tab, viewer })));
  }
  return rows;
}

/**
 * New CVs since `since` that these filters would show — the live bar's "3 new CVs". The newest one's
 * time comes back too, so the bar's next poll asks from there. Capped at one page: past 200 the bar
 * says "200+" and the reader reloads anyway.
 */
export async function loadWorkspaceArrivals(
  filters: WorkspaceFilters,
  viewer: WorkspaceViewer,
  since: Date,
): Promise<{ count: number; latestAt: string | null }> {
  if (!viewer.canRead) return { count: 0, latestAt: null };
  const p = await resolveWorkspaceParams(filters, viewer);
  const sinceIso = since.toISOString();
  const ownFrom = typeof p.from === "string" ? p.from : null;
  p.from = ownFrom && Date.parse(ownFrom) > since.getTime() ? ownFrom : sinceIso;
  p.limit = WORKSPACE_PAGE_MAX;
  const refs = await workspacePageRefs(p);
  // `from` is inclusive in the filter; "since" is strictly after the last one the screen already has.
  const fresh = refs.filter((ref) => Date.parse(ref.created_at) > since.getTime());
  return { count: fresh.length, latestAt: fresh[0]?.created_at ?? null };
}

/**
 * The answer filters of one tab. With a viewer, each list also offers the values people in that tab
 * actually stored (a typed "Other", a retired option) — read through the viewer's own filter, so a
 * fenced viewer never sees a value only a hidden person gave. Without one, the questions' own options.
 */
export async function loadAnswerFilters(tab: WorkspaceTabKey, viewer?: WorkspaceViewer): Promise<WorkspaceAnswerFilter[]> {
  const context = await loadAnswerChipContext();
  if (!viewer?.canRead) return buildAnswerFilters(tab, context);

  const p = workspaceDbParams({ ...emptyWorkspaceFilters(), archived: "include", tab }, viewer);
  const ids = await collectWorkspaceIds(p, ANSWER_VALUES_MAX_IDS);
  const keys = filterableAnswerKeys(context);
  const values = new Map<string, Set<string>>(keys.map((key) => [key, new Set<string>()]));
  const rows = await fetchRowsInBatches<Pick<CandidateRow, "declared_background" | "declared_experience" | "declared_expected_salary" | "screening_extra_answers">>(
    ids,
    (batch) =>
      recruitmentDb()
        .from("ats_candidates")
        .select("declared_background,declared_experience,declared_expected_salary,screening_extra_answers")
        .in("id", batch),
  );
  const add = (key: string, raw: unknown) => {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) values.get(key)?.add(value);
  };
  for (const row of rows) {
    add("background", row.declared_background);
    add("experience", row.declared_experience);
    add("salary", row.declared_expected_salary);
    const extras = row.screening_extra_answers ?? {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(extras, key)) add(key, extras[key]);
    }
  }
  const stored: StoredAnswerValues = {};
  for (const [key, set] of values) stored[key] = [...set].sort((a, b) => a.localeCompare(b));
  return buildAnswerFilters(tab, context, stored);
}
