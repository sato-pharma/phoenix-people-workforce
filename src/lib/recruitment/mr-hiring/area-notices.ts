// Recruitment / Medical Rep hiring — the area manager's notice, and the banner on his portal home.
//
// The owner, 7 Nov 2026: when HR passes a candidate at the 1st interview and confirms the line and
// the area, "the manager of this area must receive in-app, telegram and email … even if we will
// build a small banner … in their overview dashboard, so when they log in, they notice". His
// answers: the area's DSM on that line, or the line's NSM where the area has no real DSM; a PASS only.
//
// One row per manager told (`ats_mr_area_manager_notices`), written BEFORE the notice goes, so the
// banner stands even when Telegram or email cannot be delivered. The banner shows a manager's rows he
// has not dismissed, from the last 21 days; "Got it" stamps `seen_at` on HIS row only.
//
// SERVER ONLY. Never the CV, the salary or anything the candidate wrote — the name, the area, the line.

import { forbiddenError, notFoundError } from "@/lib/http/api-errors";
import { hrIdForStorage } from "@/lib/hr-id";
import { logError, logWarning } from "@/lib/observability/log";
import { recruitmentDb } from "@/lib/recruitment/db";
import { resolveMrAreaManagers } from "@/lib/recruitment/mr-hiring/area-manager";
import { notifyMrAreaManagers } from "@/lib/recruitment/mr-hiring/notify";
import { isMrLine, MR_LINE_LABELS, type MrLine } from "@/lib/recruitment/mr-hiring/vocabulary";

/** How long an undismissed notice stays on the banner. */
export const MR_AREA_NOTICE_DAYS = 21;
/** The most the banner lists at once — the newest first. */
export const MR_AREA_NOTICE_LIMIT = 5;

export type MrAreaNotice = {
  id: string;
  candidateName: string;
  areaName: string;
  lineLabel: string;
  seat: "dsm" | "nsm";
  createdAt: string;
};

/**
 * Tell the manager of the area HR confirmed. Runs after the reply (record.ts); never throws into it —
 * a manager nobody can be found for is logged, and the result stands.
 */
export async function tellMrAreaManagers(input: {
  candidateId: string;
  candidateName: string;
  areaName: string;
  line: MrLine;
  resultId: string;
}): Promise<void> {
  const managers = await resolveMrAreaManagers(input.areaName, input.line);
  if (!managers || managers.hrIds.length === 0) {
    logWarning("Medical Rep hiring: no manager found for the confirmed area and line", {
      labels: { area: input.areaName, event: "mr_area_manager_not_found", line: input.line },
    });
    return;
  }
  const rows = managers.hrIds.map((hrId) => ({
    area_name: input.areaName,
    candidate_id: input.candidateId,
    line: input.line,
    manager_hr_id: hrIdForStorage(hrId),
    manager_seat: managers.seat,
    result_id: Number(input.resultId),
  }));
  const { error } = await recruitmentDb()
    .from("ats_mr_area_manager_notices")
    .upsert(rows, { ignoreDuplicates: true, onConflict: "result_id,manager_hr_id" });
  if (error) {
    // The notice still goes: the bell, Telegram and email do not depend on the banner's row.
    logError("Medical Rep hiring: the area manager's banner row could not be written", {
      error,
      labels: { event: "mr_area_notice_write_failed", resultId: input.resultId },
    });
  }
  await notifyMrAreaManagers({
    areaName: input.areaName,
    candidateId: input.candidateId,
    candidateName: input.candidateName,
    hrIds: managers.hrIds,
    lineLabel: MR_LINE_LABELS[input.line],
    resultId: input.resultId,
    seat: managers.seat,
  });
}

/** The notices this manager has not dismissed, newest first. An unreadable table shows no banner. */
export async function loadMyMrAreaNotices(hrId: string | null | undefined, now: Date = new Date()): Promise<MrAreaNotice[]> {
  const manager = hrIdForStorage(hrId);
  if (!manager) return [];
  const since = new Date(now.getTime() - MR_AREA_NOTICE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await recruitmentDb()
    .from("ats_mr_area_manager_notices")
    .select("id,candidate_id,area_name,line,manager_seat,created_at")
    .eq("manager_hr_id", manager)
    .is("seen_at", null)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MR_AREA_NOTICE_LIMIT);
  if (error) {
    logWarning("Medical Rep hiring: the area manager's banner could not be read", { error, labels: { event: "mr_area_notice_read_failed" } });
    return [];
  }
  const rows = (data ?? []) as Array<{ id: number | string; candidate_id: string; area_name: string; line: string; manager_seat: string; created_at: string }>;
  if (rows.length === 0) return [];
  const { data: people } = await recruitmentDb()
    .from("ats_candidates")
    .select("id,full_name,archived_at")
    .in("id", [...new Set(rows.map((row) => row.candidate_id))]);
  const names = new Map<string, string>();
  const archived = new Set<string>();
  for (const person of (people ?? []) as Array<{ id: string; full_name: string | null; archived_at: string | null }>) {
    if (person.archived_at) archived.add(person.id);
    names.set(person.id, person.full_name?.trim() || "A candidate");
  }
  return rows
    .filter((row) => !archived.has(row.candidate_id))
    .map((row) => ({
      areaName: row.area_name,
      candidateName: names.get(row.candidate_id) ?? "A candidate",
      createdAt: row.created_at,
      id: String(row.id),
      lineLabel: isMrLine(row.line) ? MR_LINE_LABELS[row.line] : row.line,
      seat: row.manager_seat === "nsm" ? "nsm" : "dsm",
    }));
}

/** "Got it" — dismiss one notice from the banner. Only the manager it was written for may. */
export async function markMrAreaNoticeSeen(hrId: string | null | undefined, noticeId: string): Promise<void> {
  const manager = hrIdForStorage(hrId);
  if (!manager) throw forbiddenError("Sign in again to dismiss the notice.");
  const id = Number(noticeId);
  if (!Number.isSafeInteger(id) || id <= 0) throw notFoundError("Notice not found.");
  const { data, error } = await recruitmentDb()
    .from("ats_mr_area_manager_notices")
    .update({ seen_at: new Date().toISOString() })
    .eq("id", id)
    .eq("manager_hr_id", manager)
    .is("seen_at", null)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) {
    // Already dismissed is fine; someone else's notice is not found — never a hint it exists.
    const { data: own } = await recruitmentDb().from("ats_mr_area_manager_notices").select("id").eq("id", id).eq("manager_hr_id", manager).limit(1);
    if (!own || own.length === 0) throw notFoundError("Notice not found.");
  }
}
