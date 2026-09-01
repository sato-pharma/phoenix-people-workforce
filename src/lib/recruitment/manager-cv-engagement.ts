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
// SILENT, AND THAT IS A REQUIREMENT, NOT A STYLE CHOICE. The manager being measured must not be able
// to tell that his opens are watched. Nothing on his own screen changes: the open signal is written
// to `ats_candidate_views` — the same table the Talent Acquisition screening queue already uses for
// "have I read this" — keyed by his own HR_ID, and his portal ("My Candidates") reads that table
// nowhere. The report is reachable only by the five people allowed to see it (see the gate below).
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
import { canonicalHrIdKey } from "@/lib/hr-id";
import { canSeeAllRecruitment, resolveHiringManagerScopeHrIds } from "@/lib/recruitment/access";
import { markCandidateSeen } from "@/lib/recruitment/candidate-views";
import { normalizeCandidateStatus } from "@/lib/recruitment/candidate-status";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { recruitmentDb } from "@/lib/recruitment/db";
import { loadAllDistrictBoards } from "@/lib/recruitment/district-manager-folders-db";
import { getFileForDownload, listCandidateFiles, type FileDownload } from "@/lib/recruitment/files";
import { MANAGER_SENDS_TABLE } from "@/lib/recruitment/manager-sends";
import type { RecruitmentFile } from "@/lib/recruitment/types";

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
const managerCvEngagementRoles: readonly PhoenixRole[] = ["Super Admin", "CEO", "National Sales Manager", "HR Advisory"];

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
  totals: { managers: number; received: number; opened: number; notOpened: number; answered: number };
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
 */
export function aggregateManagerCvEngagement(input: {
  memberships: readonly EngagementMembership[];
  managerMeta: ReadonlyMap<string, EngagementManagerMeta>;
  candidateInfo: ReadonlyMap<string, { name: string | null; status: string | null; arrivedAt: string | null }>;
  openedKeys: ReadonlySet<string>;
  scoped: boolean;
}): ManagerCvEngagementReport {
  const byManager = new Map<string, ManagerCvEngagementRow & { seenCandidates: Set<string> }>();

  for (const membership of input.memberships) {
    const key = engagementHrKey(membership.managerHrId);
    if (!key) continue;
    const candidateId = String(membership.candidateId ?? "").trim();
    if (!candidateId) continue;

    let row = byManager.get(key);
    if (!row) {
      const meta = input.managerMeta.get(key);
      row = {
        managerHrId: meta?.managerHrId ?? membership.managerHrId,
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

  const totals = rows.reduce(
    (acc, row) => ({
      managers: acc.managers + 1,
      received: acc.received + row.received,
      opened: acc.opened + row.opened,
      notOpened: acc.notOpened + row.notOpened,
      answered: acc.answered + row.answered,
    }),
    { managers: 0, received: 0, opened: 0, notOpened: 0, answered: 0 },
  );

  return { rows, totals, scoped: input.scoped };
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

  if (memberships.length === 0) return emptyReport;

  const candidateIds = [...new Set(memberships.map((m) => m.candidateId))];
  const managerKeys = [...new Set(memberships.map((m) => engagementHrKey(m.managerHrId)).filter((k): k is string => k !== null))];

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
        name: textOrNull(row.full_name),
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
    const { data, error } = await supabase.from("lines").select("id,name");
    if (error && !isMissingRelation(error)) throw error;
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = Number(row.id);
      const name = textOrNull(row.name);
      if (Number.isFinite(id) && name) lineNameById.set(id, name);
    }
  }

  const directoryByKey = new Map<string, Record<string, unknown>>();
  for (const batch of chunkIds(managerKeys.map((k) => k.toLowerCase()))) {
    const { data, error } = await supabase
      .from("employees")
      .select("hr_id,full_name,job_title,area_name,region_name,line_id,employment_status,last_working_date")
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
      .select("hr_id,full_name,job_title,area_name,region_name,line_id,employment_status,last_working_date")
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
      name: (dir && textOrNull(dir.full_name)) || fb.name,
      jobTitle: (dir && textOrNull(dir.job_title)) || fb.jobTitle,
      area: (dir && (textOrNull(dir.area_name) ?? textOrNull(dir.region_name))) || fb.area,
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

  return aggregateManagerCvEngagement({ memberships, managerMeta, candidateInfo, openedKeys, scoped });
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
