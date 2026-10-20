// Recruitment workspace — the Talent Acquisition fence, by PERSON.
//
// THE RULE (owner, 2026-10-20). The Talent Acquisition seat (`HR Resourcing`) never sees an HR
// applicant: the people applying for her manager's seat (HR Section Head) or for her own (Talent
// Acquisition). It is a fence round a PERSON, not round two tabs — anyone with a placement in either
// HR tab, or whose own reply named an HR role (`declared_role_family`: a careers-form Talent
// Acquisition application, or the retired Human Resources tap, which waits in Needs placing), is
// hidden from her as a whole record, on every screen. `personVisibleToViewer` in role-tabs.ts is the
// rule; this file only reads what it needs to ask it, and the SQL twin lives in `ats_workspace_filter`.
//
// WHY AT THE ROUTE AND PAGE BOUNDARY, never inside `listCandidates` / `getCandidate` /
// `searchCandidates` / `getCandidateProfile`. Intake, merge and the CV extraction call those too, and
// they must see everyone — a fenced intake would make a second record for a person it cannot see.
// So every route or page that hands a candidate to a VIEWER calls one of the functions below, and
// `tests/recruitment-ta-fence.test.ts` walks that list so a new reader cannot skip it.
//
// IT COSTS NOTHING FOR EVERYONE ELSE. `fenceApplies` is pure and is asked first in every function;
// only a fenced viewer pays the one batched read (100 ids a request, placements embedded).
//
// HIDDEN READS AS NOT FOUND, never as forbidden. A 403 would tell her the person exists. For her, an
// id she may not see and an id that does not exist answer the same 404 with the same words the route
// already uses for a missing record.

import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import type { AccessContext } from "@/lib/auth/permissions";
import { scopeForRole, type PhoenixRole } from "@/lib/auth/permissions";
import { hrIdLookupKeys } from "@/lib/hr-id";
import { notFoundError } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import type { OfferRecord } from "@/lib/offers/types";
import { candidateRoleFamilyOrNull } from "@/lib/recruitment/candidate-role-family";
import { buildDailyChannelRollup, summarizeCvLifecycle, type CvLifecycleRow } from "@/lib/recruitment/cv-lifecycle";
import type { ResolvedCvLifecycleFeed } from "@/lib/recruitment/cv-lifecycle-share-links";
import type { HiredWindow, RecruitmentDashboard } from "@/lib/recruitment/dashboard";
import { chunkIds } from "@/lib/recruitment/db-batch";
import type { ReturnedCvManagerGroup } from "@/lib/recruitment/district-returns";
import { recruitmentDb } from "@/lib/recruitment/db";
import type { ManagerCvEngagementReport } from "@/lib/recruitment/manager-cv-engagement";
import {
  HR_ROLE_FAMILIES,
  HR_ROLE_TABS,
  personVisibleToViewer,
  workspaceViewer,
  type WorkspaceViewer,
} from "@/lib/recruitment/workspace/role-tabs";

type FenceViewer = Pick<AccessContext, "role" | "scope">;

/** The words a route already answers for a candidate it cannot find. */
export const CANDIDATE_NOT_FOUND = "Candidate not found.";

/** Whether this viewer is fenced at all. Pure — asked first everywhere, so nobody else pays a query. */
export function fenceApplies(access: FenceViewer | null | undefined): boolean {
  return Boolean(access) && workspaceViewer(access as FenceViewer).hidesHrPeople;
}

// ── The pure half (tests/recruitment-ta-fence.test.ts) ──────────────────────────────────────────

/** One candidate as the fence reads it: its declared role and the tabs it is placed in. */
export type FencePersonRow = {
  id: string;
  declared_role_family: string | null;
  ats_candidate_placements?: Array<{ role_tab: string | null }> | null;
};

/** The ids among these rows that this viewer may not see. */
export function hiddenPeopleFromRows(viewer: WorkspaceViewer, rows: readonly FencePersonRow[]): Set<string> {
  const hidden = new Set<string>();
  for (const row of rows) {
    const placementTabs = (row.ats_candidate_placements ?? [])
      .map((placement) => placement?.role_tab)
      .filter((tab): tab is string => typeof tab === "string" && tab.length > 0);
    if (!personVisibleToViewer(viewer, { declaredRoleFamily: row.declared_role_family, placementTabs })) {
      hidden.add(String(row.id));
    }
  }
  return hidden;
}

/**
 * Someone booked from outside Recruitment has no candidate record, so no reply of their own — the
 * interview's job title is the only role that names them. An HR title there makes them an HR applicant.
 */
export function isHrTitledInterview(jobTitle: string | null | undefined): boolean {
  const family = candidateRoleFamilyOrNull(jobTitle);
  return family !== null && HR_ROLE_FAMILIES.includes(family);
}

/**
 * An applicant kept in the WhatsApp CV Archive has no candidate record either: the title they applied
 * for, or a cabinet folder named for an HR role, is what makes them an HR applicant.
 */
export function isHrArchivedApplicant(row: { job_title: string | null; folder_path?: readonly (string | null)[] | null }): boolean {
  return isHrTitledInterview(row.job_title) || (row.folder_path ?? []).some((segment) => isHrTitledInterview(segment));
}

/** The returned-CV queue without the hidden people: an emptied reason or manager leaves, and each total is taken again. */
export function withoutHiddenReturnedCvs(
  groups: readonly ReturnedCvManagerGroup[],
  hidden: ReadonlySet<string>,
): ReturnedCvManagerGroup[] {
  if (hidden.size === 0) return [...groups];
  return groups
    .map((group) => {
      const reasons = group.reasons
        .map((reason) => ({ ...reason, items: reason.items.filter((item) => !hidden.has(item.candidateId)) }))
        .filter((reason) => reason.items.length > 0);
      return { ...group, reasons, total: reasons.reduce((total, reason) => total + reason.items.length, 0) };
    })
    .filter((group) => group.total > 0);
}

/** A WhatsApp chat is hidden when its linked person is, or when the number tapped an HR role. */
export function hiddenInboxConversationIds(
  rows: ReadonlyArray<{ id: string; candidateId: string | null; contactWaId: string | null }>,
  hiddenCandidates: ReadonlySet<string>,
  hrWaIds: ReadonlySet<string>,
): Set<string> {
  const hidden = new Set<string>();
  for (const row of rows) {
    if ((row.candidateId && hiddenCandidates.has(row.candidateId)) || (row.contactWaId && hrWaIds.has(row.contactWaId))) {
      hidden.add(row.id);
    }
  }
  return hidden;
}

/** The manager-engagement report without the hidden people, every count taken again off what stays. */
export function withoutHiddenEngagementCandidates(
  report: ManagerCvEngagementReport,
  hidden: ReadonlySet<string>,
): ManagerCvEngagementReport {
  if (hidden.size === 0) return report;
  const rows = report.rows
    .map((row) => {
      const candidates = row.candidates.filter((candidate) => !hidden.has(candidate.candidateId));
      const opened = candidates.filter((candidate) => candidate.opened).length;
      return {
        ...row,
        answered: candidates.filter((candidate) => candidate.answered).length,
        candidates,
        notOpened: candidates.length - opened,
        opened,
        received: candidates.length,
        emptiedByFence: candidates.length === 0 && row.candidates.length > 0,
      };
    })
    // A manager is dropped only when the fence emptied him; one who had nothing stays as he was.
    .filter((row) => !row.emptiedByFence)
    .map(({ emptiedByFence: _emptied, ...row }) => row);
  const totals = rows.reduce(
    (acc, row) => ({
      answered: acc.answered + row.answered,
      managers: acc.managers + 1,
      notOpened: acc.notOpened + row.notOpened,
      opened: acc.opened + row.opened,
      received: acc.received + row.received,
    }),
    { answered: 0, managers: 0, notOpened: 0, opened: 0, received: 0 },
  );
  return { ...report, rows, totals };
}

/** An interview request as the fence reads it: its CVs, each naming a Recruitment candidate or none. */
export type FenceableInterviewRequest = {
  items: ReadonlyArray<{ candidateId: string | null; booked: boolean }>;
  pendingItemCount: number;
};

/**
 * These requests without the CVs of hidden people. Someone from outside names no candidate, so stays.
 * A request the fence EMPTIED is dropped whole — it was only ever about hidden people — while one that
 * had no CVs to begin with stays as it was. `pendingItemCount` is counted again over what is left.
 */
export function withoutHiddenRequestItems<R extends FenceableInterviewRequest>(
  requests: readonly R[],
  hidden: ReadonlySet<string>,
): R[] {
  if (hidden.size === 0) return [...requests];
  const kept: R[] = [];
  for (const request of requests) {
    const items = request.items.filter((item) => !item.candidateId || !hidden.has(item.candidateId));
    if (items.length === request.items.length) {
      kept.push(request);
      continue;
    }
    if (items.length === 0) continue;
    kept.push({ ...request, items, pendingItemCount: items.filter((item) => !item.booked).length });
  }
  return kept;
}

// ── The read ────────────────────────────────────────────────────────────────────────────────────

/** Which of these ids are HR people for this viewer, and which exist at all. One read per 100 ids. */
async function readPeople(viewer: WorkspaceViewer, ids: readonly string[]): Promise<{ hidden: Set<string>; found: Set<string> }> {
  const hidden = new Set<string>();
  const found = new Set<string>();
  const wanted = Array.from(new Set(ids.filter((id) => isUuid(id))));
  for (const batch of chunkIds(wanted)) {
    const { data, error } = await recruitmentDb()
      .from("ats_candidates")
      .select("id, declared_role_family, ats_candidate_placements(role_tab)")
      .in("id", batch);
    // A fence that cannot read fails CLOSED: the route answers 500, never the hidden person.
    if (error) throw error;
    const rows = (data ?? []) as FencePersonRow[];
    for (const row of rows) found.add(String(row.id));
    for (const id of hiddenPeopleFromRows(viewer, rows)) hidden.add(id);
  }
  return { found, hidden };
}

/** The visible subset of these candidate ids. Every id comes back for a viewer who is not fenced. */
export async function fenceCandidateIds(access: FenceViewer, ids: readonly string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  if (!fenceApplies(access)) return new Set(unique);
  const { hidden } = await readPeople(workspaceViewer(access), unique);
  return new Set(unique.filter((id) => !hidden.has(id)));
}

/** Rows whose candidate this viewer may see; a row naming no candidate stays. */
export async function fenceRowsByCandidate<T>(
  access: FenceViewer,
  rows: readonly T[],
  candidateIdOf: (row: T) => string | null | undefined,
): Promise<T[]> {
  if (!fenceApplies(access)) return [...rows];
  const ids = rows.map(candidateIdOf).filter((id): id is string => typeof id === "string" && id.length > 0);
  const visible = await fenceCandidateIds(access, ids);
  return rows.filter((row) => {
    const id = candidateIdOf(row);
    return !id || visible.has(id);
  });
}

/** True when this viewer may not see this candidate — hidden, or (for her) not there at all. */
export async function candidateHiddenFrom(access: FenceViewer, candidateId: string | null | undefined): Promise<boolean> {
  if (!fenceApplies(access)) return false;
  const id = String(candidateId ?? "").trim();
  if (!isUuid(id)) return true;
  const { found, hidden } = await readPeople(workspaceViewer(access), [id]);
  return hidden.has(id) || !found.has(id);
}

/** Throws the route's own 404 when this viewer may not see this candidate. Free for everyone else. */
export async function assertCandidateVisible(
  access: FenceViewer,
  candidateId: string | null | undefined,
  message: string = CANDIDATE_NOT_FOUND,
): Promise<void> {
  if (await candidateHiddenFrom(access, candidateId)) throw notFoundError(message);
}

/** Every one of these candidates, or a 404: a batch that names a hidden person is refused whole. */
export async function assertCandidatesVisible(access: FenceViewer, candidateIds: readonly string[]): Promise<void> {
  if (!fenceApplies(access)) return;
  const unique = Array.from(new Set(candidateIds.filter(Boolean)));
  const { found, hidden } = await readPeople(workspaceViewer(access), unique);
  if (unique.some((id) => hidden.has(id) || !found.has(id))) throw notFoundError(CANDIDATE_NOT_FOUND);
}

// ── Things that lead to a candidate ─────────────────────────────────────────────────────────────

/** One application, by its id — its candidate decides. */
export async function assertApplicationVisible(
  access: FenceViewer,
  applicationId: string | null | undefined,
  message = "Application not found.",
): Promise<void> {
  if (!fenceApplies(access)) return;
  const id = String(applicationId ?? "").trim();
  const missing = notFoundError(message);
  if (!isUuid(id)) throw missing;
  const { data, error } = await recruitmentDb().from("ats_applications").select("candidate_id").eq("id", id).maybeSingle();
  if (error) throw error;
  const candidateId = (data as { candidate_id: string | null } | null)?.candidate_id ?? null;
  if (!data || (await candidateHiddenFrom(access, candidateId))) throw missing;
}

/** One recruitment file, by its id — the candidate it belongs to (directly, or through its application) decides. */
export async function assertCandidateFileVisible(
  access: FenceViewer,
  fileId: string | null | undefined,
  message = "File not found.",
): Promise<void> {
  if (!fenceApplies(access)) return;
  const id = String(fileId ?? "").trim();
  if (!isUuid(id)) throw notFoundError(message);
  const { data, error } = await recruitmentDb().from("ats_files").select("candidate_id, application_id").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw notFoundError(message);
  let candidateId = (data as { candidate_id: string | null }).candidate_id;
  const applicationId = (data as { application_id: string | null }).application_id;
  if (!candidateId && applicationId) {
    const { data: application, error: applicationError } = await recruitmentDb()
      .from("ats_applications")
      .select("candidate_id")
      .eq("id", applicationId)
      .maybeSingle();
    if (applicationError) throw applicationError;
    candidateId = (application as { candidate_id: string | null } | null)?.candidate_id ?? null;
  }
  if (candidateId && (await candidateHiddenFrom(access, candidateId))) throw notFoundError(message);
}

/** One interview booking: its candidate, or — for someone from outside — the job it is for. */
export async function assertInterviewBookingVisible(access: FenceViewer, bookingId: string | null | undefined): Promise<void> {
  if (!fenceApplies(access)) return;
  const id = String(bookingId ?? "").trim();
  const missing = notFoundError("Interview not found.");
  if (!isUuid(id)) throw missing;
  const { data, error } = await recruitmentDb()
    .from("ats_interview_bookings")
    .select("candidate_id, interview_job_title")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw missing;
  const row = data as { candidate_id: string | null; interview_job_title: string | null };
  if (row.candidate_id ? await candidateHiddenFrom(access, row.candidate_id) : isHrTitledInterview(row.interview_job_title)) {
    throw missing;
  }
}

/** One CV on an interview request: its candidate decides; someone from outside carries no role, so stays. */
export async function assertInterviewRequestItemVisible(
  access: FenceViewer,
  itemId: string | null | undefined,
  message = "No CV is on record for this person.",
): Promise<void> {
  if (!fenceApplies(access)) return;
  const id = String(itemId ?? "").trim();
  if (!isUuid(id)) return;
  const { data, error } = await recruitmentDb().from("ats_interview_request_items").select("candidate_id").eq("id", id).maybeSingle();
  if (error) throw error;
  const candidateId = (data as { candidate_id: string | null } | null)?.candidate_id ?? null;
  if (candidateId && (await candidateHiddenFrom(access, candidateId))) {
    throw notFoundError(message);
  }
}

/** The interviews this viewer may see: a candidate's by the person, an outsider's by the job title. */
export async function fenceInterviewBookings<T extends { candidateId: string | null; jobTitle: string | null }>(
  access: FenceViewer,
  bookings: readonly T[],
): Promise<T[]> {
  if (!fenceApplies(access)) return [...bookings];
  const visible = await fenceCandidateIds(
    access,
    bookings.map((booking) => booking.candidateId).filter((id): id is string => Boolean(id)),
  );
  return bookings.filter((booking) => (booking.candidateId ? visible.has(booking.candidateId) : !isHrTitledInterview(booking.jobTitle)));
}

/** Rows that carry only a booking id (the Zoom reminder): the booking's person, or its job title, decides. */
export async function fenceRowsByInterviewBooking<T>(
  access: FenceViewer,
  rows: readonly T[],
  bookingIdOf: (row: T) => string | null | undefined,
): Promise<T[]> {
  if (!fenceApplies(access) || rows.length === 0) return [...rows];
  const ids = Array.from(new Set(rows.map(bookingIdOf).filter((id): id is string => typeof id === "string" && isUuid(id))));
  const hiddenBookings = new Set<string>();
  const bookings: Array<{ id: string; candidateId: string | null; jobTitle: string | null }> = [];
  for (const batch of chunkIds(ids)) {
    const { data, error } = await recruitmentDb()
      .from("ats_interview_bookings")
      .select("id, candidate_id, interview_job_title")
      .in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id: string; candidate_id: string | null; interview_job_title: string | null }>) {
      bookings.push({ candidateId: row.candidate_id, id: String(row.id), jobTitle: row.interview_job_title });
    }
  }
  const visible = new Set((await fenceInterviewBookings(access, bookings)).map((booking) => booking.id));
  for (const booking of bookings) if (!visible.has(booking.id)) hiddenBookings.add(booking.id);
  return rows.filter((row) => {
    const id = bookingIdOf(row);
    return !id || !hiddenBookings.has(id);
  });
}

/** The words the request routes already answer for a request that is not there. */
export const INTERVIEW_REQUEST_NOT_FOUND = "That interview request is no longer there.";

/** The interview requests this viewer may see: hidden people's CVs leave, and a request only about them leaves whole. */
export async function fenceInterviewRequests<R extends FenceableInterviewRequest>(
  access: FenceViewer,
  requests: readonly R[],
): Promise<R[]> {
  if (!fenceApplies(access)) return [...requests];
  const ids = requests.flatMap((request) =>
    request.items.map((item) => item.candidateId).filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  if (ids.length === 0) return [...requests];
  const visible = await fenceCandidateIds(access, ids);
  return withoutHiddenRequestItems(requests, new Set(ids.filter((id) => !visible.has(id))));
}

/** One request handed back to a viewer: fenced like the list, and a request the fence empties answers as gone. */
export async function fenceInterviewRequest<R extends FenceableInterviewRequest>(access: FenceViewer, request: R): Promise<R> {
  if (!fenceApplies(access)) return request;
  const [kept] = await fenceInterviewRequests(access, [request]);
  if (!kept) throw notFoundError(INTERVIEW_REQUEST_NOT_FOUND);
  return kept;
}

/** One request, by its id, BEFORE anything changes it: a request only about hidden people answers as gone. */
export async function assertInterviewRequestVisible(access: FenceViewer, requestId: string | null | undefined): Promise<void> {
  if (!fenceApplies(access)) return;
  const id = String(requestId ?? "").trim();
  if (!isUuid(id)) throw notFoundError(INTERVIEW_REQUEST_NOT_FOUND);
  const { data, error } = await recruitmentDb().from("ats_interview_request_items").select("candidate_id, booking_id").eq("request_id", id);
  if (error) throw error;
  const items = ((data ?? []) as Array<{ candidate_id: string | null; booking_id: string | null }>).map((row) => ({
    booked: Boolean(row.booking_id),
    candidateId: row.candidate_id,
  }));
  await fenceInterviewRequest(access, { items, pendingItemCount: 0 });
}

/** The WhatsApp chats this viewer may not see, among these. */
export async function inboxConversationsHiddenFrom(
  access: FenceViewer,
  rows: ReadonlyArray<{ id: string; candidateId: string | null; contactWaId: string | null }>,
): Promise<Set<string>> {
  if (!fenceApplies(access) || rows.length === 0) return new Set();
  const candidateIds = rows.map((row) => row.candidateId).filter((id): id is string => Boolean(id));
  const { hidden: hiddenCandidates } = await readPeople(workspaceViewer(access), candidateIds);
  // A chat with nobody linked yet is fenced by what the number tapped: any HR role in any session.
  const hrWaIds = new Set<string>();
  const waIds = Array.from(new Set(rows.map((row) => row.contactWaId).filter((id): id is string => Boolean(id))));
  for (const batch of chunkIds(waIds)) {
    const { data, error } = await recruitmentDb()
      .from("ats_whatsapp_classification_sessions")
      .select("wa_id")
      .in("wa_id", batch)
      .in("job_title_family", [...HR_ROLE_FAMILIES]);
    if (error) throw error;
    for (const session of (data ?? []) as Array<{ wa_id: string | null }>) {
      if (session.wa_id) hrWaIds.add(session.wa_id);
    }
  }
  return hiddenInboxConversationIds(rows, hiddenCandidates, hrWaIds);
}

/** A manager's district boards without the hidden people; each board's count is taken again off what stays. */
export async function fenceDistrictBoards<
  TCandidate extends { id: string },
  TBoard extends { candidateCount: number; folders: ReadonlyArray<{ candidates: TCandidate[] }> },
>(access: FenceViewer, boards: readonly TBoard[]): Promise<TBoard[]> {
  if (!fenceApplies(access)) return [...boards];
  const ids = boards.flatMap((board) => board.folders.flatMap((folder) => folder.candidates.map((candidate) => candidate.id)));
  const visible = await fenceCandidateIds(access, ids);
  return boards.map((board) => {
    const folders = board.folders.map((folder) => ({
      ...folder,
      candidates: folder.candidates.filter((candidate) => visible.has(candidate.id)),
    }));
    return { ...board, candidateCount: folders.reduce((total, folder) => total + folder.candidates.length, 0), folders };
  });
}

/** The returned-CV queue as this viewer may read it. */
export async function fenceReturnedCvQueue(
  access: FenceViewer,
  groups: readonly ReturnedCvManagerGroup[],
): Promise<ReturnedCvManagerGroup[]> {
  if (!fenceApplies(access)) return [...groups];
  const ids = groups.flatMap((group) => group.reasons.flatMap((reason) => reason.items.map((item) => item.candidateId)));
  const visible = await fenceCandidateIds(access, ids);
  return withoutHiddenReturnedCvs(groups, new Set(ids.filter((id) => !visible.has(id))));
}

/** The manager-engagement report as this viewer may read it. */
export async function fenceManagerEngagementReport(
  access: FenceViewer,
  report: ManagerCvEngagementReport,
): Promise<ManagerCvEngagementReport> {
  if (!fenceApplies(access)) return report;
  const ids = report.rows.flatMap((row) => row.candidates.map((candidate) => candidate.candidateId));
  const visible = await fenceCandidateIds(access, ids);
  return withoutHiddenEngagementCandidates(report, new Set(ids.filter((id) => !visible.has(id))));
}

// ── The CV-lifecycle sheet link: fenced by whoever MADE it ──────────────────────────────────────

/**
 * Whether a sheet link's maker is fenced. The feed has no viewer — a Google Sheet's script reads it —
 * so the link carries its maker's fence: one she makes never carries an HR applicant. Her seat is
 * read off the account (`app_auth_users.role`, the permission key); an account that cannot be read
 * fences, because the safe mistake here is a shorter sheet.
 */
async function sheetLinkMakerFenced(createdByHrId: string | null | undefined): Promise<boolean> {
  const keys = hrIdLookupKeys(createdByHrId ?? "");
  if (keys.length === 0) return true;
  const { data, error } = await recruitmentDb().from("app_auth_users").select("role, is_active").in("hr_id", keys);
  if (error) return true;
  const roles = ((data ?? []) as Array<{ role: string | null; is_active: boolean | null }>)
    .filter((row) => row.is_active !== false && row.role)
    .map((row) => String(row.role) as PhoenixRole);
  if (roles.length === 0) return true;
  return roles.some((role) => fenceApplies({ role, scope: scopeForRole(role) }));
}

/** The sheet feed without the HR applicants when its maker is fenced; the summary is taken again. */
export async function fenceCvLifecycleFeed(feed: ResolvedCvLifecycleFeed): Promise<ResolvedCvLifecycleFeed> {
  if (!(await sheetLinkMakerFenced(feed.createdByHrId))) return feed;
  const fenced: FenceViewer = { role: "HR Resourcing", scope: scopeForRole("HR Resourcing") };
  const rows: CvLifecycleRow[] = await fenceRowsByCandidate(fenced, feed.rows, (row) => row.candidateId);
  if (rows.length === feed.rows.length) return feed;
  return { ...feed, daily: buildDailyChannelRollup(rows), rows, summary: summarizeCvLifecycle(rows) };
}

// ── The HR dashboards (her Talent Acquisition overview and the HR Command Center) ───────────────

/** The parts of an HR dashboard's sources that name a person. */
type HrDashboardSources = { offers?: OfferRecord[]; recruitment?: RecruitmentDashboard };

/**
 * An HR dashboard's sources as this viewer may read them, fenced IN PLACE, right after they load and
 * before any task or tile builder names a person: an HR applicant's application and waiting CV leave,
 * and so does an offer for an HR job — an offer carries no candidate record, so its job title is the
 * only role that names the person (as for someone booked from outside). Free for everyone else.
 */
export async function fenceHrDashboardSources(access: FenceViewer, loaded: HrDashboardSources): Promise<void> {
  if (!fenceApplies(access)) return;
  const recruitment = loaded.recruitment;
  if (recruitment) {
    const awaiting = recruitment.awaitingReview;
    const visible = await fenceCandidateIds(access, [
      ...recruitment.applications.map((application) => application.candidateId),
      ...(awaiting ?? []).map((row) => row.id),
    ]);
    loaded.recruitment = {
      ...recruitment,
      applications: recruitment.applications.filter(
        (application) => !application.candidateId || visible.has(application.candidateId),
      ),
      ...(awaiting ? { awaitingReview: awaiting.filter((row) => visible.has(row.id)) } : {}),
    };
  }
  if (loaded.offers) loaded.offers = loaded.offers.filter((offer) => !isHrTitledInterview(offer.title));
}

const RECEIVED_PAGE_SIZE = 1000;

/** Every page of one read, so a long window is never cut at the API's row cap. */
async function everyPage<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += RECEIVED_PAGE_SIZE) {
    const { data, error } = await read(offset, offset + RECEIVED_PAGE_SIZE - 1);
    // Fails CLOSED like every read here: the card is then absent, never a count that includes her hidden people.
    if (error) throw error;
    const page = (Array.isArray(data) ? data : []) as T[];
    rows.push(...page);
    if (page.length < RECEIVED_PAGE_SIZE) return rows;
  }
}

/**
 * The "CVs received" figure as this viewer may read it: the HR applicants who arrived in the window
 * come off the total `countCandidatesReceivedInWindow` counted. Only the people who COULD be hidden
 * are read — an HR role in their own reply, or a placement in an HR tab — never the whole window.
 */
export async function fenceCandidatesReceivedCount(access: FenceViewer, window: HiredWindow, total: number): Promise<number> {
  if (!fenceApplies(access)) return total;
  const from = cairoMidnightUtcIso(window.fromIso);
  const to = cairoMidnightUtcIso(window.toIso, 1);
  const columns = "id, declared_role_family, ats_candidate_placements(role_tab)";
  const declared = await everyPage<FencePersonRow>((start, end) =>
    recruitmentDb()
      .from("ats_candidates")
      .select(columns)
      .in("declared_role_family", [...HR_ROLE_FAMILIES])
      .gte("created_at", from)
      .lt("created_at", to)
      .order("id")
      .range(start, end),
  );
  const placements = await everyPage<{ candidate_id: string | null }>((start, end) =>
    recruitmentDb()
      .from("ats_candidate_placements")
      .select("candidate_id")
      .in("role_tab", [...HR_ROLE_TABS])
      .order("candidate_id")
      .range(start, end),
  );
  const placedIds = Array.from(
    new Set(placements.map((row) => row.candidate_id).filter((id): id is string => typeof id === "string" && id.length > 0)),
  );
  const placed: FencePersonRow[] = [];
  for (const batch of chunkIds(placedIds)) {
    const { data, error } = await recruitmentDb()
      .from("ats_candidates")
      .select(columns)
      .in("id", batch)
      .gte("created_at", from)
      .lt("created_at", to);
    if (error) throw error;
    placed.push(...((data ?? []) as FencePersonRow[]));
  }
  const hidden = hiddenPeopleFromRows(workspaceViewer(access), [...declared, ...placed]);
  return Math.max(0, total - hidden.size);
}
