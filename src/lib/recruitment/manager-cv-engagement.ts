// Recruitment / ATS — the silent manager-engagement report.
//
// WHAT THIS ANSWERS. "Every manager was sent how many CVs, which did he open, and which did he
// never look at." A recruiter pushes a CV to a District Manager; the owner's worry is the manager
// who lets it sit. Three numbers per manager say whether that is happening: RECEIVED (what was
// pushed to him), ANSWERED (he recorded a decision — interview / not interested), and OPENED (he
// actually opened the CV document).
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
//     manager opening a CV before it (measured 2026-08-31: every row in ats_candidate_views belonged
//     to the one screener, B-10). So a CV received before this feature, and not re-opened since,
//     reads as "not opened" even if the manager read it on paper months ago. The UI says so; do not
//     "fix" a wave of not-opened on historical rows — it is the true absence of a signal, not a bug.
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
import { MANAGER_SENDS_TABLE } from "@/lib/recruitment/manager-sends";

/** The roles that may open the report at all — the owner's list, verbatim. NOT SFE, NOT HR. */
const managerCvEngagementRoles: readonly PhoenixRole[] = ["Super Admin", "CEO", "National Sales Manager"];

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
 * The one spelling of an HR_ID used to join a send (stored lower-canonical) to a view (stored
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

/** One CV a manager was sent, and what he did with it. */
export type ManagerCvEngagementCandidate = {
  candidateId: string;
  candidateName: string | null;
  sentAt: string;
  /** He opened the actual CV document (tracked from the ship date forward — see the file header). */
  opened: boolean;
  /** He recorded a decision — shortlisted / rejected / hired (full history). */
  answered: boolean;
  /** The candidate's current status code, for the label the row shows. */
  status: string | null;
  /** The position the CV was sent FOR, when the send recorded one. */
  positionLabel: string | null;
};

/** One manager, with the three headline numbers and the CVs behind them. */
export type ManagerCvEngagementRow = {
  managerHrId: string;
  managerName: string | null;
  managerJobTitle: string | null;
  managerArea: string | null;
  managerRegion: string | null;
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

/** The raw shape the pure aggregator consumes — one row per (candidate, manager) send. */
export type EngagementSendInput = {
  candidateId: string;
  managerHrId: string;
  managerName: string | null;
  managerJobTitle: string | null;
  managerArea: string | null;
  managerRegion: string | null;
  sentAt: string;
  positionLabel: string | null;
};

/**
 * Fold sends + candidate facts + open-marks into one row per manager. PURE — no database — so the
 * counting can be tested exhaustively without one, and the page cannot render a total the tests
 * never saw.
 *
 * @param sends         every in-scope send, already filtered to the viewer's scope by the caller.
 * @param candidateInfo candidateId -> { name, status }. A missing entry means the candidate row is
 *                      gone; the send still counts as received, with an unknown name and no answer.
 * @param openedKeys    set of `${engagementHrKey(manager)}::${candidateId}` for which a view row
 *                      exists under that manager's own HR_ID.
 */
export function aggregateManagerCvEngagement(input: {
  sends: readonly EngagementSendInput[];
  candidateInfo: Map<string, { name: string | null; status: string | null }>;
  openedKeys: ReadonlySet<string>;
  scoped: boolean;
}): ManagerCvEngagementReport {
  const byManager = new Map<
    string,
    ManagerCvEngagementRow & { seenCandidates: Set<string> }
  >();

  for (const send of input.sends) {
    const key = engagementHrKey(send.managerHrId);
    if (!key) continue;
    const candidateId = String(send.candidateId ?? "").trim();
    if (!candidateId) continue;

    let row = byManager.get(key);
    if (!row) {
      row = {
        managerHrId: send.managerHrId,
        managerName: send.managerName,
        managerJobTitle: send.managerJobTitle,
        managerArea: send.managerArea,
        managerRegion: send.managerRegion,
        received: 0,
        opened: 0,
        notOpened: 0,
        answered: 0,
        candidates: [],
        seenCandidates: new Set<string>(),
      };
      byManager.set(key, row);
    } else {
      // A later send may carry a resolved name where an earlier one did not — keep the best we have,
      // never overwrite a real value with a blank.
      row.managerName = row.managerName ?? send.managerName;
      row.managerJobTitle = row.managerJobTitle ?? send.managerJobTitle;
      row.managerArea = row.managerArea ?? send.managerArea;
      row.managerRegion = row.managerRegion ?? send.managerRegion;
    }

    // One CV counts once per manager even if the send trail holds it twice (a re-send upserts, but
    // a legacy row plus a new one can still coexist). The candidate list, and every count off it, is
    // deduplicated on candidate id.
    if (row.seenCandidates.has(candidateId)) continue;
    row.seenCandidates.add(candidateId);

    const info = input.candidateInfo.get(candidateId) ?? { name: null, status: null };
    const opened = input.openedKeys.has(`${key}::${candidateId}`);
    // Answered = the manager recorded a decision (interview → shortlisted, not interested → rejected,
    // or hired). A null/unknown status — a deleted candidate row — is NOT answered.
    const normalizedStatus = normalizeCandidateStatus(info.status);
    const answered = normalizedStatus !== null && decidedCandidateStatuses.has(normalizedStatus);

    row.candidates.push({
      candidateId,
      candidateName: info.name,
      sentAt: send.sentAt,
      opened,
      answered,
      status: info.status,
      positionLabel: send.positionLabel,
    });
    row.received += 1;
    if (opened) row.opened += 1;
    else row.notOpened += 1;
    if (answered) row.answered += 1;
  }

  const rows: ManagerCvEngagementRow[] = [...byManager.values()]
    .map(({ seenCandidates: _seen, ...row }) => {
      // Newest CV first inside each manager, so the freshest thing he has not opened sits at the top.
      row.candidates.sort((left, right) => right.sentAt.localeCompare(left.sentAt));
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

function positionLabelFrom(row: Record<string, unknown>): string | null {
  const parts = [row.sent_for_job_title, row.sent_for_area, row.sent_for_line]
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length > 0);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Read every in-scope send, enrich with candidate facts and open-marks, and aggregate.
 *
 * Degrades to an empty report (never throws) when the send table is not in this database yet — the
 * code ships on a merge to `main` minutes before its migration is confirmed, and an empty report is
 * a far better failure than a 500 on the page.
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

  // Every send, newest first, bounded well under the 1,000-row PostgREST cliff (71 rows on
  // 2026-08-31). Filtered to the viewer's scope in memory rather than in SQL so a mixed-case manager
  // id cannot silently drop a whole manager from an `.in()`.
  const sendsResult = await supabase
    .from(MANAGER_SENDS_TABLE)
    .select(
      "candidate_id,manager_hr_id,manager_name,manager_area,manager_job_title,manager_region,sent_for_area,sent_for_job_title,sent_for_line,sent_at",
    )
    .order("sent_at", { ascending: false })
    .limit(5000);

  if (sendsResult.error) {
    if (isMissingRelation(sendsResult.error)) {
      return { rows: [], totals: { managers: 0, received: 0, opened: 0, notOpened: 0, answered: 0 }, scoped: scopeKeys !== null };
    }
    throw sendsResult.error;
  }

  const sends: EngagementSendInput[] = [];
  for (const raw of (sendsResult.data ?? []) as Array<Record<string, unknown>>) {
    const managerKey = engagementHrKey(String(raw.manager_hr_id ?? ""));
    if (!managerKey) continue;
    if (scopeKeys && !scopeKeys.has(managerKey)) continue;
    const candidateId = String(raw.candidate_id ?? "").trim();
    if (!candidateId) continue;
    sends.push({
      candidateId,
      managerHrId: String(raw.manager_hr_id ?? ""),
      managerName: textOrNull(raw.manager_name),
      managerJobTitle: textOrNull(raw.manager_job_title),
      managerArea: textOrNull(raw.manager_area),
      managerRegion: textOrNull(raw.manager_region),
      sentAt: String(raw.sent_at ?? ""),
      positionLabel: positionLabelFrom(raw),
    });
  }

  const candidateIds = [...new Set(sends.map((send) => send.candidateId))];

  // Candidate name + status, for the answered signal and the human-readable row. Chunked because a
  // PostgREST `.in()` carrying hundreds of ids can silently return nothing.
  const candidateInfo = new Map<string, { name: string | null; status: string | null }>();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase.from("ats_candidates").select("id,full_name,status").in("id", batch);
    if (error) {
      if (isMissingRelation(error)) break;
      throw error;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const id = String(row.id ?? "").trim();
      if (!id) continue;
      candidateInfo.set(id, { name: textOrNull(row.full_name), status: textOrNull(row.status) });
    }
  }

  // Every view of these candidates, then narrowed to views made by the MANAGER himself. A view by
  // anyone else — the screener, an upline opening it in the team view — is attributed to that
  // person, never to the manager who let the CV sit.
  const openedKeys = new Set<string>();
  for (const batch of chunkIds(candidateIds)) {
    const { data, error } = await supabase
      .from("ats_candidate_views")
      .select("candidate_id,viewer_hr_id")
      .in("candidate_id", batch);
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

  return aggregateManagerCvEngagement({ sends, candidateInfo, openedKeys, scoped: scopeKeys !== null });
}

function textOrNull(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
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
