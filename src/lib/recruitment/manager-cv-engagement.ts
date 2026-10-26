// Recruitment / ATS — the silent manager-engagement report.
//
// WHAT THIS ANSWERS. "Every manager was sent how many CVs, which did he open, and which did he
// never look at." A recruiter pushes a CV to a District Manager; the owner's worry is the manager
// who lets it sit. Three numbers per manager say whether that is happening: RECEIVED (everything in
// front of him), ANSWERED (he recorded a decision — interview / not interested), and OPENED (he
// actually opened the CV document).
//
// WHAT "RECEIVED" MEANS — HIS WHOLE FOLDER, NOT JUST THE HAND-OFFS. Owner call, 2026-09-01: the
// report must match what the manager actually sees in My Candidates. That surface is his DISTRICT
// FOLDER — every CV whose applicant is in one of his areas, plus the governorate-backfilled
// historicals — and it is far larger than the handful a recruiter explicitly pushed him (Dina's
// folder held 41 the day the report showed 6). So RECEIVED = the union of his folder
// (placeCandidatesInDistrictFolders, the same rule that fills My Candidates) and anything hand-pushed
// straight to him (the send trail + manager_notified_hr_id), deduplicated per candidate. The union,
// not the folder alone, is what keeps a CV stranded on a resigned manager or an NSM — who holds no
// district folder — visible instead of vanishing.
//
// SILENT WHEN HE OPENS, VISIBLE TO HIS COLLEAGUES SINCE 2026-09-20. Nothing on his own screen changes
// when he opens a CV: the open signal is written to `ats_candidate_views` — the same table the
// Talent Acquisition screening queue already uses for "have I read this" — keyed by his own HR_ID.
// Until 2026-09-20 his portal ("My Candidates") read that table nowhere, so no colleague could tell
// either. The owner then ruled that a CV's card names everybody else who has opened it, by name,
// title and time (candidate-openers.ts), so a manager can now see that a peer has read a CV. This
// REPORT is unchanged and is still reachable only by the five people allowed to see it (see the
// gate below); what changed is that the raw fact "X opened this CV at T" is no longer hidden.
//
// TWO SIGNALS, TWO HISTORIES, ON PURPOSE.
//   • ANSWERED is derived from the candidate's own status and therefore has FULL history — a CV a
//     manager shortlisted last week already reads as answered.
//   • OPENED can only count from the day the open-recorder below ships. Nothing ever recorded a
//     manager opening a CV before it. So a CV received before this feature, and not re-opened since,
//     reads as "not opened" even if the manager read it on paper months ago. Since RECEIVED now spans
//     his whole folder, most of which predates open-tracking, "not opened" is large by construction —
//     that backlog IS the signal the report exists to surface, not a bug to explain away.
//
// SCOPE. Super Admin and the CEO see every manager. A National Sales Manager sees only his own line,
// resolved through resolveHiringManagerScopeHrIds — the same LINE scope the rest of recruitment uses
// for him, so the set he is offered here cannot drift from the set he is offered elsewhere. No other
// role reaches this at all.

import type { AccessContext, PhoenixRole } from "@/lib/auth/permissions";
import { tidyAllCapitalsName } from "@/lib/employees/display-name";
import { isActiveLifecycleStatus } from "@/lib/employees/employee-directory";
import { EMPLOYEE_AREA_SELECT, resolveEmployeeAreaName } from "@/lib/employees/employee-org-labels";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { canSeeAllRecruitment, resolveHiringManagerScopeHrIds } from "@/lib/recruitment/access";
import { markCandidateSeen } from "@/lib/recruitment/candidate-views";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { loadAllDistrictBoards } from "@/lib/recruitment/district-manager-folders-db";
import { loadFolderHolderKeys } from "@/lib/recruitment/folder-holders";
import {
  distinctEngagementTotals,
  type ManagerCvEngagementTotals,
} from "@/lib/recruitment/manager-cv-engagement-totals";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import { MANAGER_SENDS_TABLE } from "@/lib/recruitment/manager-sends";
import { UNNAMED_USER_LABEL } from "@/lib/recruitment/person-labels";
import { loadReferenceLines } from "@/lib/reference/reference-lists";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import type { RecruitmentFile } from "@/lib/recruitment/types";
import { isUuid } from "@/lib/http/uuid";

export { distinctEngagementTotals, type ManagerCvEngagementTotals };

/**
 * The roles that may open the report at all.
 *
 * The original list was the owner's, verbatim, and read "NOT SFE, NOT HR". He AMENDED it on
 * 2026-09-01, asked directly and answering yes, to add the HR Business Partner: chasing the
 * managers who have not answered on a candidate is her recruiting job, and until then the report
 * that measures it was the one recruiting screen she could not open.
 *
 * The amendment is HR Advisory alone. SFE is still out, and so is HR Operations — she runs
 * records, attendance and payroll inputs, and no part of that reads a hiring manager's response
 * time. Written as a role set rather than a permission for the reason below.
 */
// HR Resourcing (the Talent Acquisition seat) joined on 2026-10-08, ticked by the owner on the access
// blueprint, for the reason he gave HR Advisory: chasing a silent manager is recruiting work.
const managerCvEngagementRoles: readonly PhoenixRole[] = [
  "Super Admin",
  "CEO",
  "National Sales Manager",
  // HR Advisory left on 2026-10-08 with the rest of recruiting ("move recruiting off the HR Business
  // Partner"): chasing a silent manager is recruiting work, now the Talent Acquisition seat's.
  "HR Resourcing",
];

/**
 * May this viewer open the silent manager-engagement report?
 *
 * A role-set gate rather than a permission resource, matching the module's other narrow-audience
 * reads (canViewInboundIntakeHealth, canReviewCandidateContacts): the audience — Super Admin, CEO,
 * the three National Sales Managers — does not line up with any single resource grant, and inventing
 * one would only add a second thing to keep in step with this list. This function IS the boundary;
 * both page twins call it and redirect on false.
 */
export function canViewManagerCvEngagement(access: Pick<AccessContext, "role" | "scope">): boolean {
  return access.scope === "system" || managerCvEngagementRoles.includes(access.role);
}

/**
 * The one spelling of an HR_ID used to join a membership (stored lower-canonical) to a view (stored
 * upper-canonical) to a scope key. HR_IDs in this codebase are mixed case and a plain equality has
 * under-returned by 28% elsewhere, so every side is forced through this before it is compared.
 */
export function engagementHrKey(value: string | null | undefined): string | null {
  return canonicalHrIdKey(value)?.toUpperCase() ?? null;
}

// A recorded decision. new / sent_to_manager are the two "still waiting" states; a candidate reaches
// a manager's list at sent_to_manager, so ANSWERED is exactly these three. Written as a positive set,
// not "anything that is not waiting" — the latter counts a null/deleted status as answered, which is
// the opposite of the truth (an unknown status means no decision we can see).
const decidedCandidateStatuses = new Set(["shortlisted", "rejected", "hired"]);

/** One CV a manager can see, and what he did with it. */
export type ManagerCvEngagementCandidate = {
  candidateId: string;
  candidateName: string | null;
  /**
   * The folder this CV sits in for this manager — a named area ("Nasr City"), the district catch-all
   * ("No area named"), or null when it reached him only by a hand-push and belongs to no folder. The
   * expanded row groups the CVs by this, which is what the owner asked for on 2026-09-01.
   */
  area: string | null;
  /** When the CV entered the system — the folder has no "sent" date, so this is what the row shows. */
  arrivedAt: string | null;
  /** He opened the actual CV document (tracked from the ship date forward — see the file header). */
  opened: boolean;
  /** He recorded a decision — shortlisted / rejected / hired (full history). */
  answered: boolean;
  /** The candidate's current status code, for the label the row shows. */
  status: string | null;
};

/** One manager, with the three headline numbers and the CVs behind them. */
export type ManagerCvEngagementRow = {
  managerHrId: string;
  managerName: string | null;
  managerJobTitle: string | null;
  managerArea: string | null;
  /** The product line — Anti Infective / Pedia / CNS — resolved from the directory, not the HR prefix. */
  managerLine: string | null;
  /** He is no longer active (resigned / terminated / inactive); his sitting CVs may need reassigning. */
  inactive: boolean;
  /** The status word to badge him with when inactive — "Resigned" etc., as the directory records it. */
  employmentStatusLabel: string | null;
  /** His last working day, when the directory records one — shown beside the inactive badge. */
  lastWorkingDate: string | null;
  received: number;
  opened: number;
  notOpened: number;
  answered: number;
  candidates: ManagerCvEngagementCandidate[];
};

export type ManagerCvEngagementReport = {
  rows: ManagerCvEngagementRow[];
  /** The header tiles: every CV counted ONCE however many managers hold it — see distinctEngagementTotals. */
  totals: ManagerCvEngagementTotals;
  /** True when the viewer sees only his own line (a National Sales Manager) rather than everyone. */
  scoped: boolean;
};

/** One (manager, candidate) membership — a candidate that reached this manager by any route. */
export type EngagementMembership = {
  managerHrId: string;
  candidateId: string;
  /**
   * The folder the CV is in for this manager — the area name, the district catch-all, or null for a
   * hand-push that belongs to no folder. The same candidate can arrive by two routes (folder AND
   * push); the aggregator keeps the first non-null area it sees, so the folder's area wins over a
   * push that carries none.
   */
  area?: string | null;
};

/** What the report knows about a manager, independent of any single CV. */
export type EngagementManagerMeta = {
  managerHrId: string;
  name: string | null;
  jobTitle: string | null;
  area: string | null;
  line: string | null;
  inactive: boolean;
  employmentStatusLabel: string | null;
  lastWorkingDate: string | null;
};

/**
 * Fold memberships + candidate facts + manager facts + open-marks into one row per manager. PURE —
 * no database — so the counting can be tested exhaustively without one, and the page cannot render a
 * total the tests never saw.
 *
 * @param memberships   every in-scope (manager, candidate) pair. Duplicates are fine — a candidate
 *                      that reached a manager by two routes is counted once, here.
 * @param managerMeta   engagementHrKey(manager) -> identity (name, area, line, inactive…).
 * @param candidateInfo candidateId -> { name, status, arrivedAt }. A missing entry means the row is
 *                      gone; the membership still counts as received, unnamed and never "answered".
 * @param openedKeys    set of `${engagementHrKey(manager)}::${candidateId}` for which a view row
 *                      exists under that manager's own HR_ID.
 * @param rosterManagerHrIds every active manager in scope, CVs or not. Each gets a row — at zero when
 *                      nothing reached him — so "every manager on your line" really is every one.
 */
export function aggregateManagerCvEngagement(input: {
  memberships: readonly EngagementMembership[];
  managerMeta: ReadonlyMap<string, EngagementManagerMeta>;
  candidateInfo: ReadonlyMap<string, { name: string | null; status: string | null; arrivedAt: string | null }>;
  openedKeys: ReadonlySet<string>;
  scoped: boolean;
  rosterManagerHrIds?: readonly string[];
}): ManagerCvEngagementReport {
  const byManager = new Map<string, ManagerCvEngagementRow & { seenCandidates: Set<string> }>();

  const rowFor = (key: string, managerHrId: string): ManagerCvEngagementRow & { seenCandidates: Set<string> } => {
    let row = byManager.get(key);
    if (!row) {
      const meta = input.managerMeta.get(key);
      row = {
        managerHrId: meta?.managerHrId ?? managerHrId,
        managerName: meta?.name ?? null,
        managerJobTitle: meta?.jobTitle ?? null,
        managerArea: meta?.area ?? null,
        managerLine: meta?.line ?? null,
        inactive: meta?.inactive ?? false,
        employmentStatusLabel: meta?.employmentStatusLabel ?? null,
        lastWorkingDate: meta?.lastWorkingDate ?? null,
        received: 0,
        opened: 0,
        notOpened: 0,
        answered: 0,
        candidates: [],
        seenCandidates: new Set<string>(),
      };
      byManager.set(key, row);
    }
    return row;
  };

  // The roster first, so a manager nothing reached still reads as a row of zeros.
  for (const managerHrId of input.rosterManagerHrIds ?? []) {
    const key = engagementHrKey(managerHrId);
    if (key) rowFor(key, managerHrId);
  }

  for (const membership of input.memberships) {
    const key = engagementHrKey(membership.managerHrId);
    if (!key) continue;
    const candidateId = String(membership.candidateId ?? "").trim();
    if (!candidateId) continue;

    const row = rowFor(key, membership.managerHrId);

    const membershipArea = String(membership.area ?? "").trim() || null;

    // One CV counts once per manager even if it reached him by two routes (a folder match AND a
    // hand-push). The candidate list, and every count off it, is deduplicated on candidate id — but a
    // later route may still fill in an area the first one lacked (a bare push seen before the folder
    // placement that knows the area).
    if (row.seenCandidates.has(candidateId)) {
      if (membershipArea) {
        const existing = row.candidates.find((entry) => entry.candidateId === candidateId);
        if (existing && !existing.area) existing.area = membershipArea;
      }
      continue;
    }
    row.seenCandidates.add(candidateId);

    const info = input.candidateInfo.get(candidateId) ?? { name: null, status: null, arrivedAt: null };
    const opened = input.openedKeys.has(`${key}::${candidateId}`);
    // Answered = the manager recorded a decision (interview → shortlisted, not interested → rejected,
    // or hired). A null/unknown status — a deleted candidate row — is NOT answered.
    const normalizedStatus = normalizeCandidateStatus(info.status);
    const answered = normalizedStatus !== null && decidedCandidateStatuses.has(normalizedStatus);

    row.candidates.push({
      candidateId,
      candidateName: info.name,
      area: membershipArea,
      arrivedAt: info.arrivedAt,
      opened,
      answered,
      status: info.status,
    });
    row.received += 1;
    if (opened) row.opened += 1;
    else row.notOpened += 1;
    if (answered) row.answered += 1;
  }

  const rows: ManagerCvEngagementRow[] = [...byManager.values()]
    .map(({ seenCandidates: _seen, ...row }) => {
      // Newest CV first inside each manager, so the freshest thing he has not opened sits at the top.
      row.candidates.sort((left, right) => String(right.arrivedAt ?? "").localeCompare(String(left.arrivedAt ?? "")));
      return row;
    })
    // Most CVs first; ties broken by who is ignoring the most, then by name — the manager the report
    // exists to surface reads at the top.
    .sort((left, right) => {
      if (right.received !== left.received) return right.received - left.received;
      if (right.notOpened !== left.notOpened) return right.notOpened - left.notOpened;
      return String(left.managerName ?? left.managerHrId).localeCompare(String(right.managerName ?? right.managerHrId));
    });

  return { rows, totals: distinctEngagementTotals(rows), scoped: input.scoped };
}

/** True when the error is "that table/column is not in this database yet". */
function isMissingRelation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42P01" || code === "42703" || code === "PGRST205") return true;
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /schema cache/i.test(message);
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

// An employment_status the directory reports as anything other than active. Held as a set rather than
// `!== 'active'` so a null/blank status (an incomplete row) reads as "not flagged", never as a false
// resignation badge over a manager who is fine.
const inactiveEmploymentStatuses = new Set(["resigned", "terminated", "inactive", "suspended"]);

/** A person's name for the report: trimmed, and an all-capitals spelling tidied for display. */
function displayNameOrNull(value: unknown): string | null {
  const text = textOrNull(value);
  return text ? tidyAllCapitalsName(text) : null;
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Read every in-scope membership (folder ∪ hand-push), enrich with candidate facts, manager identity
 * and open-marks, and aggregate.
 *
 * Degrades to an empty report (never throws) when a source table is not in this database yet — the
 * code ships on a merge to `main` minutes before its migration is confirmed, and an empty report is
 * a far better failure than a 500 on the page. Each source is guarded independently so a missing
 * newer table cannot blank a signal an older one could still provide.
 */
export async function loadManagerCvEngagement(access: AccessContext): Promise<ManagerCvEngagementReport> {
  const supabase = recruitmentDb();

  // null = see everyone (Super Admin / CEO); a Set = this National Sales Manager's line only.
  const scopeHrIds = canSeeAllRecruitment(access) ? null : await resolveHiringManagerScopeHrIds(access);
  const scopeKeys = scopeHrIds
    ? new Set(
        [...scopeHrIds].map((value) => engagementHrKey(value)).filter((value): value is string => value !== null),
      )
    : null;
  const scoped = scopeKeys !== null;
  const inScope = (managerHrId: string): boolean => {
    if (!scopeKeys) return true;
    const key = engagementHrKey(managerHrId);
    return key !== null && scopeKeys.has(key);
  };

  const emptyReport: ManagerCvEngagementReport = {
    rows: [],
    totals: { managers: 0, received: 0, opened: 0, notOpened: 0, answered: 0 },
    scoped,
  };

  const memberships: EngagementMembership[] = [];
  // Per-manager fallback identity harvested from the sources themselves, used only where the
  // directory has nothing (a manager whose employees row is gone but who still holds stranded CVs).
  const fallbackMeta = new Map<string, { name: string | null; jobTitle: string | null; area: string | null; line: string | null }>();
  const noteFallback = (managerHrId: string, patch: Partial<{ name: string | null; jobTitle: string | null; area: string | null; line: string | null }>): void => {
    const key = engagementHrKey(managerHrId);
    if (!key) return;
    const current = fallbackMeta.get(key) ?? { name: null, jobTitle: null, area: null, line: null };
    fallbackMeta.set(key, {
      name: current.name ?? patch.name ?? null,
      jobTitle: current.jobTitle ?? patch.jobTitle ?? null,
      area: current.area ?? patch.area ?? null,
      line: current.line ?? patch.line ?? null,
    });
  };

  // ── ROUTE 1: the folder — every CV whose applicant is in one of his areas, plus the backfill ────
  // The same placement rule that fills My Candidates, so the report cannot disagree with the screen.
  // A failed read degrades to no folder memberships; the hand-push routes below still stand.
  try {
    const { boards } = await loadAllDistrictBoards();
    for (const board of boards) {
      if (!board.managerHrId) continue;
      if (!inScope(board.managerHrId)) continue;
      noteFallback(board.managerHrId, { line: board.lineName, area: board.regionName });
      for (const folder of board.folders) {
        // The folder name IS the area the expanded report groups by — a named area, or the district
        // catch-all "No area named". A hand-push (routes 2 and 3) belongs to no folder, so it carries
        // no area and the aggregator groups it under "Sent directly".
        for (const candidate of folder.candidates) {
          const candidateId = String(candidate.id ?? "").trim();
          if (candidateId) memberships.push({ managerHrId: board.managerHrId, candidateId, area: folder.areaName });
        }
      }
    }
  } catch {
    /* folders unavailable — fall through to the hand-push routes */
  }

  // ── ROUTE 2: the send trail — a CV pushed to one or more managers (since 2026-08-30) ────────────
  const sendsResult = await supabase
    .from(MANAGER_SENDS_TABLE)
    .select("candidate_id,manager_hr_id,manager_name,manager_job_title,manager_area,manager_region,sent_for_line")
    .limit(5000);
  if (sendsResult.error && !isMissingRelation(sendsResult.error)) throw sendsResult.error;
  for (const raw of ((sendsResult.data ?? []) as Array<Record<string, unknown>>)) {
    const managerHrId = String(raw.manager_hr_id ?? "");
    if (!engagementHrKey(managerHrId) || !inScope(managerHrId)) continue;
    const candidateId = String(raw.candidate_id ?? "").trim();
    if (!candidateId) continue;
    memberships.push({ managerHrId, candidateId });
    noteFallback(managerHrId, {
      name: textOrNull(raw.manager_name),
      jobTitle: textOrNull(raw.manager_job_title),
      area: textOrNull(raw.manager_area) ?? textOrNull(raw.manager_region),
      line: textOrNull(raw.sent_for_line),
    });
  }

  // ── ROUTE 3: manager_notified_hr_id — the original single-push stamp on the candidate itself ────
  const notifiedResult = await supabase
    .from("ats_candidates")
    .select("id,manager_notified_hr_id,manager_notified_name,manager_notified_job_title,manager_notified_area,manager_notified_region")
    .not("manager_notified_hr_id", "is", null)
    .limit(5000);
  if (notifiedResult.error && !isMissingRelation(notifiedResult.error)) throw notifiedResult.error;
  for (const raw of ((notifiedResult.data ?? []) as Array<Record<string, unknown>>)) {
    const managerHrId = String(raw.manager_notified_hr_id ?? "");
    if (!engagementHrKey(managerHrId) || !inScope(managerHrId)) continue;
    const candidateId = String(raw.id ?? "").trim();
    if (!candidateId) continue;
    memberships.push({ managerHrId, candidateId });
    noteFallback(managerHrId, {
      name: textOrNull(raw.manager_notified_name),
      jobTitle: textOrNull(raw.manager_notified_job_title),
      area: textOrNull(raw.manager_notified_area) ?? textOrNull(raw.manager_notified_region),
    });
  }

  // ── THE ROSTER: every manager who holds CV folders (district, acting district, regional and national
  // sales managers — the people a CV is sent to), in scope. The intro promises "every manager on your
  // line", so a manager nothing has reached is listed at zero rather than left out. Only an ACTIVE one
  // (the directory's own rule, below): a departed manager appears only while CVs still sit with him.
  // An unreadable organogram reads as nobody, and the CV routes above still stand.
  const rosterKeys = [...(await loadFolderHolderKeys())]
    .map((value) => engagementHrKey(value))
    .filter((key): key is string => key !== null && inScope(key));

  if (memberships.length === 0 && rosterKeys.length === 0) return emptyReport;

  const candidateIds = [...new Set(memberships.map((m) => m.candidateId))];
  const managerKeys = [
    ...new Set([
      ...rosterKeys,
      ...memberships.map((m) => engagementHrKey(m.managerHrId)).filter((k): k is string => k !== null),
    ]),
  ];

  // Candidate name + status + arrival date, for the answered signal and the human-readable row.
  // Chunked because a PostgREST `.in()` carrying hundreds of ids can silently return nothing.
  const candidateInfo = new Map<string, { name: string | null; status: string | null; arrivedAt: string | null }>();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase.from("ats_candidates").select("id,full_name,status,created_at").in("id", batch);
    if (error) {
      if (isMissingRelation(error)) break;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      candidateInfo.set(id, {
        // Display only: a name typed all in capitals reads in title case beside the others.
        name: displayNameOrNull(row.full_name),
        status: textOrNull(row.status),
        arrivedAt: textOrNull(row.created_at),
      });
    }
  }

  // Manager identity from the directory — the authoritative name, job title, area and (via the lines
  // table) the product LINE, plus the employment status that decides the inactive badge. The HR prefix
  // is NOT the line here (Dina's id starts b- yet she is on Anti Infective), so line_id is read, never
  // the id. Chunked, and matched case-insensitively because the two tables store the id in different
  // cases.
  const lineNameById = new Map<number, string>();
  {
    // From the shared one-minute copy (src/lib/reference/reference-lists.ts). It kept its tolerance
    // of a missing `lines` relation — an environment without the sales tables still renders this
    // report, with no line on each manager — and that is all it tolerates: any other failure throws.
    let rows: Awaited<ReturnType<typeof loadReferenceLines>> = [];
    try {
      rows = await loadReferenceLines();
    } catch (error) {
      if (!isMissingRelation(error)) throw error;
    }
    for (const row of rows) {
      const id = Number(row.id);
      const name = textOrNull(row.name);
      if (Number.isFinite(id) && name) lineNameById.set(id, name);
    }
  }

  const directoryByKey = new Map<string, Record<string, unknown>>();
  for (const batch of chunkIds(managerKeys.map((k) => k.toLowerCase()))) {
    const { data, error } = await supabase
      .from("employees")
      .select(`hr_id,full_name,job_title,region_name,line_id,employment_status,last_working_date,${EMPLOYEE_AREA_SELECT}`)
      .in("hr_id", batch);
    if (error) {
      if (isMissingRelation(error)) break;
      // employees is queried lower-cased; the ids may be stored upper. Retry once with the upper set
      // before giving up, so a case mismatch does not silently blank every manager's identity.
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = engagementHrKey(String(row.hr_id ?? ""));
      if (key) directoryByKey.set(key, row);
    }
  }
  // The `.in()` above matched only ids that happen to be stored lower-case. Sweep the rest with the
  // upper spelling — employees here are stored UPPER (A-12, B-12), so this is the pass that hits.
  const stillMissing = managerKeys.filter((k) => !directoryByKey.has(k));
  for (const batch of chunkIds(stillMissing)) {
    const { data, error } = await supabase
      .from("employees")
      .select(`hr_id,full_name,job_title,region_name,line_id,employment_status,last_working_date,${EMPLOYEE_AREA_SELECT}`)
      .in("hr_id", batch);
    if (error) {
      if (isMissingRelation(error)) break;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const key = engagementHrKey(String(row.hr_id ?? ""));
      if (key) directoryByKey.set(key, row);
    }
  }

  const managerMeta = new Map<string, EngagementManagerMeta>();
  for (const key of managerKeys) {
    const dir = directoryByKey.get(key);
    const fb = fallbackMeta.get(key) ?? { name: null, jobTitle: null, area: null, line: null };
    const lineId = dir ? Number(dir.line_id) : NaN;
    const status = dir ? String(dir.employment_status ?? "").trim().toLowerCase() : "";
    const inactive = inactiveEmploymentStatuses.has(status);
    managerMeta.set(key, {
      managerHrId: dir ? String(dir.hr_id) : key,
      name: (dir && displayNameOrNull(dir.full_name)) || displayNameOrNull(fb.name),
      jobTitle: (dir && textOrNull(dir.job_title)) || fb.jobTitle,
      // The area from the `area_id` LINK, with `region_name` still behind it for a seat that has
      // no area at all. `employees.area_name` is a snapshot frozen at write time — see
      // employee-org-labels.ts — so taking it first showed a manager the territory name from
      // before a split.
      area: (dir && (resolveEmployeeAreaName(dir) ?? textOrNull(dir.region_name))) || fb.area,
      line: (Number.isFinite(lineId) ? lineNameById.get(lineId) ?? null : null) || fb.line,
      inactive,
      employmentStatusLabel: inactive ? titleCase(status) : null,
      lastWorkingDate: dir ? textOrNull(dir.last_working_date) : null,
    });
  }

  // Every view of these candidates, narrowed to views made by the MANAGER himself. A view by anyone
  // else — the screener, an upline opening it in the team view — is attributed to that person, never
  // to the manager who let the CV sit.
  const openedKeys = new Set<string>();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase.from("ats_candidate_views").select("candidate_id,viewer_hr_id").in("candidate_id", batch);
    if (error) {
      if (isMissingRelation(error)) break;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const candidateId = String(row.candidate_id ?? "").trim();
      const viewerKey = engagementHrKey(String(row.viewer_hr_id ?? ""));
      if (candidateId && viewerKey) openedKeys.add(`${viewerKey}::${candidateId}`);
    }
  }

  // A roster manager is listed only when the directory knows him and says he is active — the same
  // lifecycle rule as the employee directory (active, on leave, or no status recorded).
  const rosterManagerHrIds = rosterKeys.filter((key) => {
    const dir = directoryByKey.get(key);
    return dir !== undefined && isActiveLifecycleStatus(textOrNull(dir.employment_status));
  });

  return aggregateManagerCvEngagement({ memberships, managerMeta, candidateInfo, openedKeys, scoped, rosterManagerHrIds });
}

/**
 * Silently record that a manager opened a CV.
 *
 * The whole reason the report can ever say "opened". Called from downloadHiringManagerCandidateFile
 * — the one chokepoint both the in-app preview and the download link pass through — after the scope
 * check has already proved this caller may see this CV. Best-effort by design: it reuses
 * markCandidateSeen, which no-ops on a missing table or a session with no HR_ID and never throws for
 * either, and the caller wraps it besides, because a tracking write must never break a CV opening.
 *
 * Also called from the "I will call" route at the moment it reveals the phone number. The owner,
 * 2026-09-13: revealing the number marks the CV as seen.
 *
 * Keyed by the opener's own HR_ID. An upline opening a CV in the team view records the OPEN under the
 * upline, not under the manager who was sent it — which is exactly right: the manager who never
 * opened it must keep reading as not-opened.
 */
export async function recordManagerCvOpen(input: {
  candidateId: string;
  viewerHrId: string | null | undefined;
}): Promise<void> {
  await markCandidateSeen({ candidateId: input.candidateId, viewerHrId: input.viewerHrId });
}

// ── The report's OWN CV preview — deliberately SILENT ─────────────────────────────────────────────
//
// The owner, 2026-09-01: opening a manager's row and clicking a candidate must pop the CV up in place.
// The five people who can open this report are its readers (Super Admin, CEO, the three NSMs), NOT the
// managers being measured — so a preview here is OVERSIGHT, not a manager screening his own folder. It
// must therefore record NO open: routing it through downloadHiringManagerCandidateFile would write an
// ats_candidate_views row under the reader, and for an NSM reading his own line that would inflate the
// exact "opened" number this report exists to measure. So these two go straight to the silent file
// primitives (listCandidateFiles / getFileForDownload) and never touch recordManagerCvOpen.
//
// The BOUNDARY is canViewManagerCvEngagement, enforced in the two route handlers that call these — the
// same gate the page itself redirects on, so "if you can read the report, you can preview its CVs".
// These functions do the file work only; they must be reached from a handler that has already checked
// that gate.

/** The candidate's files, for the report's silent preview. Records nothing. */
export async function listManagerEngagementCandidateFiles(candidateId: string): Promise<RecruitmentFile[]> {
  // A malformed id is NOT FOUND, not a fault: this is a uuid column, and Postgres answers a
  // non-uuid with 22P02 from the WHERE clause instead of with no rows, which leaves as a 500.
  if (!isUuid(candidateId)) throw new Error("Candidate not found.");
  return listCandidateFiles(candidateId);
}

/**
 * One file's bytes for the report's silent preview, after proving the file belongs to the candidate
 * (so a fileId cannot be swapped for another candidate's document). Records nothing.
 */
export async function getManagerEngagementCandidateFile(
  candidateId: string,
  fileId: string,
): Promise<FileDownload | null> {
  const files = await listCandidateFiles(candidateId);
  if (!files.some((file) => file.id === fileId)) {
    throw new Error("Forbidden: file does not belong to this candidate.");
  }
  return getFileForDownload(fileId);
}

/**
 * Whether this reader may open THIS candidate's CVs from the report — the line scope, per candidate.
 *
 * THE LEAK THIS CLOSES (audit, 2026-09-12). The two preview routes checked only
 * `canViewManagerCvEngagement` — "may you read the report at all". The report itself is scoped: a
 * National Sales Manager sees his own line's managers and nothing else. The preview was not, so any
 * candidate id in the company opened, CV bytes and all, for an NSM who only had to type it.
 *
 * THE SAME THREE ROUTES AS THE REPORT, and the same scope: a candidate is in this reader's view when
 * one of his in-scope managers holds them by the manager stamp on the candidate, the send trail, or
 * the district folder. Cheapest first, because a preview is one click and the folders are the heavy
 * read. A reader the report does not scope (Super Admin, CEO, and any role the line scope does not
 * cover) sees everything here too — anything stricter would hide CVs the report is showing him.
 */
export async function canViewManagerEngagementCandidate(access: AccessContext, candidateId: string): Promise<boolean> {
  if (!canViewManagerCvEngagement(access)) return false;
  // Not found, not forbidden — same answer the file functions give a malformed id.
  if (!isUuid(candidateId)) throw new Error("Candidate not found.");
  if (canSeeAllRecruitment(access)) return true;
  const scopeHrIds = await resolveHiringManagerScopeHrIds(access);
  if (scopeHrIds === null) return true;
  const scopeKeys = new Set(
    [...scopeHrIds].map((value) => engagementHrKey(value)).filter((value): value is string => value !== null),
  );
  if (scopeKeys.size === 0) return false;
  const inScope = (managerHrId: unknown): boolean => {
    const key = engagementHrKey(String(managerHrId ?? ""));
    return key !== null && scopeKeys.has(key);
  };

  const supabase = recruitmentDb();

  // ROUTE 3 — the manager stamp on the candidate itself.
  const { data: stamp, error: stampError } = await supabase
    .from("ats_candidates")
    .select("manager_notified_hr_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (stampError) throw stampError;
  if (!stamp) return false;
  if (inScope((stamp as { manager_notified_hr_id?: unknown }).manager_notified_hr_id)) return true;

  // ROUTE 2 — the send trail.
  const sends = await supabase.from(MANAGER_SENDS_TABLE).select("manager_hr_id").eq("candidate_id", candidateId);
  if (sends.error && !isMissingRelation(sends.error)) throw sends.error;
  if (((sends.data ?? []) as Array<{ manager_hr_id?: unknown }>).some((row) => inScope(row.manager_hr_id))) return true;

  // ROUTE 1 — the district folders. Degrades exactly as the report does: unreadable folders count
  // for nothing, and the two routes above still stand.
  try {
    const { boards } = await loadAllDistrictBoards();
    for (const board of boards) {
      if (!board.managerHrId || !inScope(board.managerHrId)) continue;
      for (const folder of board.folders) {
        if (folder.candidates.some((candidate) => String(candidate.id ?? "").trim() === candidateId)) return true;
      }
    }
  } catch {
    /* folders unavailable — the hand-push routes above are all this reader can be shown */
  }
  return false;
}

/**
 * The viewer's own name, for the "Generated by" line on the XLSX export's cover sheet.
 *
 * The owner's standing rule is that a person is shown by name, never by a raw id, and the access
 * context carries only an HR_ID — so the directory is asked for one. HR_IDs in this codebase are
 * mixed case (`A-12` / `a-12`) and a plain `.eq` has under-returned by 28% elsewhere, so the lookup
 * goes through the shared `namesByHrId`. It was an `ilike` with no wildcard — an exact, case-blind
 * match, which worked — and the shared read also folds the legacy `aaa`→`aa` alias, which `ilike`
 * never did, and cannot be turned into a pattern match by an id carrying `%` or `_`.
 *
 * NEVER THROWS. This decorates a provenance line — an export that failed because the directory was
 * briefly unreachable would be a far worse outcome than one whose cover could not name the exporter.
 * The shared lookup does not throw either; the catch stays as the belt to that braces.
 *
 * AND NEVER FALLS BACK TO THE ID. It used to answer `access.hrId ?? access.loginId ?? "System"`, so
 * a directory blip put "B-10" on the cover of a file that leaves the building — the raw code the
 * rule forbids, in the one field a reader consults to find out who produced the numbers. "System"
 * was worse than useless there: it is a positive claim that nobody produced it. Words instead.
 */
export async function resolveManagerEngagementViewerName(access: AccessContext): Promise<string> {
  const hrId = String(access.hrId ?? "").trim();
  if (!hrId) return UNNAMED_USER_LABEL;
  try {
    // Nickname-aware, like every other live surface: the cover says "Omar Gawish", not the legal
    // name that only payroll and the signed documents use. That rule lives in the shared lookup.
    const names = await namesByHrId([hrId]);
    return names.get(hrId) ?? UNNAMED_USER_LABEL;
  } catch {
    return UNNAMED_USER_LABEL;
  }
}
