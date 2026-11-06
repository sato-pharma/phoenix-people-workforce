// Recruitment / ATS — the folder that does not stop reminding until its CV is opened.
//
// The owner, 2026-10-16: when a CV reaches a manager's folder, "the folder pumps notifications and
// never stop until the cv is seen". The first alert is the one the send itself raises
// (pushCandidatesToManager). This is every one after it: hourly through the Cairo working day, one
// message per manager naming every CV not yet opened, until each one is opened, is taken back, or is
// seven days old (REMINDER_MAX_DAYS; the CV stays in the folder, only the nag ends).
//
// "SEEN" IS "OPENED", and it is the manager's own `ats_candidate_views` row — the same row the
// recruiter's "Opened by" banner reads. A view at or after the send counts; a re-push after an old
// open is unseen again, because the manager is being asked again. Taking the CV back deletes the
// send, so a recalled CV stops pinging in the same instant.
//
// Only managers who hold folders are reminded. A head-office manager who was sent a CV gets the one
// alert the send raises and nothing after it — hourly reminders are what a folder does.
//
// NEVER EMAIL: the same owner rule as the send, enforced by the same guard (the event type is
// `candidate_assigned`), and stated in the channel list so the intent reads where it is written.

import { canonicalHrIdKey } from "@/lib/hr-id";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { candidateAlertIdempotencyKey } from "@/lib/recruitment/candidate-alert-key";
import { recruitmentDb } from "@/lib/recruitment/db";
import { chunkIds } from "@/lib/recruitment/db-batch";
import { boardsForManager, districtReturnSuppressionKey } from "@/lib/recruitment/district-manager-folders";
import { loadDistrictSeatRows } from "@/lib/recruitment/district-manager-folders-db";
import {
  isReminderHour,
  isWithinReminderWindow,
  managerFolderShelves,
  reminderHourBucket,
  unseenSendsByManager,
  type FolderSend,
} from "@/lib/recruitment/manager-cv-folders";
import { listAllManagerSends } from "@/lib/recruitment/manager-sends";
import { fetchAllRows } from "@/lib/supabase/paginated";

export type ManagerCvReminderResult = {
  /** CVs named across every reminder sent (or that would be, on a dry run). */
  cvs: number;
  dryRun: boolean;
  failed: number;
  /** Managers who were (or would be) reminded. */
  managers: number;
  /** Set when the run did nothing on purpose — it is night in Cairo. */
  skipped: "outside_hours" | null;
};

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Every `ats_candidate_views` open of these CVs, keyed the way the planner reads them. */
async function loadLastSeen(candidateIds: readonly string[]): Promise<Map<string, string>> {
  const lastSeen = new Map<string, string>();
  const supabase = recruitmentDb();
  for (const batch of chunkIds([...new Set(candidateIds)])) {
    let rows: Array<{ candidate_id?: string; viewer_hr_id?: string; last_seen_at?: string }>;
    try {
      // Every open of the batch, paged to a short page: one row per viewer per CV, so a batch of a
      // hundred CVs can outgrow one response, and an open that was cut off would be nagged about again.
      // `viewer_hr_id` follows the `candidate_id` order and together they are unique.
      rows = await fetchAllRows<{ candidate_id?: string; viewer_hr_id?: string; last_seen_at?: string }>(
        () =>
          supabase
            .from("ats_candidate_views")
            .select("candidate_id,viewer_hr_id,last_seen_at")
            .in("candidate_id", batch)
            .order("candidate_id", { ascending: true }),
        "viewer_hr_id",
      );
    } catch (error) {
      // A missing table reads as "nobody has seen anything" — the reminders then go out, which is the
      // safe direction for a feature whose whole point is not to be missed.
      if ((error as { code?: string }).code === "42P01") continue;
      throw error;
    }
    for (const row of rows) {
      if (!row.candidate_id || !row.viewer_hr_id || !row.last_seen_at) continue;
      lastSeen.set(districtReturnSuppressionKey(row.viewer_hr_id, row.candidate_id), row.last_seen_at);
    }
  }
  return lastSeen;
}

async function loadNames(candidateIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const supabase = recruitmentDb();
  for (const batch of chunkIds([...new Set(candidateIds)])) {
    const { data, error } = await supabase.from("ats_candidates").select("id,full_name").in("id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ id?: string; full_name?: string | null }>) {
      if (row.id) names.set(row.id, String(row.full_name ?? "").trim() || "A candidate");
    }
  }
  return names;
}

/**
 * One reminder per manager who holds a folder and has an unopened CV in it.
 *
 * `dryRun` reads everything and sends nothing. Each manager is sent independently: a failed
 * notification for one is logged and counted and never stops the others, because a reminder that
 * cannot reach one person must still reach everyone else.
 */
export async function runManagerCvReminders(
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<ManagerCvReminderResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const result: ManagerCvReminderResult = { cvs: 0, dryRun, failed: 0, managers: 0, skipped: null };

  if (!isReminderHour(now)) return { ...result, skipped: "outside_hours" };

  const [rows, sends] = await Promise.all([loadDistrictSeatRows(), listAllManagerSends({ now, withinHold: true })]);
  if (!sends || sends.length === 0 || rows.length === 0) return result;

  const shelves = managerFolderShelves(rows);
  const folderSends: FolderSend[] = sends
    .filter((send) => boardsForManager(shelves, send.managerHrId).length > 0)
    // Seven days and the nag ends; the CV stays in the folder (owner, 2026-10-16).
    .filter((send) => isWithinReminderWindow(send.sentAt, now))
    .map((send) => ({
      candidateId: send.candidateId,
      folderArea: send.position?.areaName ?? null,
      managerHrId: send.managerHrId,
      sentAt: send.sentAt,
    }));
  if (folderSends.length === 0) return result;

  const lastSeenByKey = await loadLastSeen(folderSends.map((send) => send.candidateId));
  const unseen = unseenSendsByManager({ lastSeenByKey, sends: folderSends });
  if (unseen.size === 0) return result;

  const names = await loadNames([...unseen.values()].flatMap((entry) => entry.candidateIds));
  const hourBucket = reminderHourBucket(now);

  for (const entry of unseen.values()) {
    if (!canonicalHrIdKey(entry.managerHrId)) continue;
    result.managers += 1;
    result.cvs += entry.candidateIds.length;
    if (dryRun) continue;

    const people = entry.candidateIds.map((id) => names.get(id) ?? "A candidate");
    const many = people.length > 1;
    try {
      await createSystemNotification({
        actionUrl: "/employee-portals/recruitment-candidates",
        // Never email (owner rule, 2026-08-24, kept for this event): the guard strips it anyway.
        channels: ["in_app", "telegram", "push"],
        eventType: "candidate_assigned",
        message: `${joinNames(people)} ${many ? "are" : "is"} waiting in your folders and ${many ? "have" : "has"} not been opened yet. Open ${many ? "them" : "it"} and this reminder stops.`,
        // A NEW row every hour, deliberately: the same key would overwrite the last reminder in place
        // and keep its read state, so a manager who read one would never see the next. The hour is
        // the identity, so a double-fired run still sends once, and a reminder of a different set of
        // CVs is a different reminder.
        metadata: {
          idempotencyKey: candidateAlertIdempotencyKey({
            candidateIds: entry.candidateIds,
            eventType: "candidate_reminder",
            managerHrId: entry.managerHrId,
            sentAtIso: hourBucket,
          }),
        },
        module: "recruitment",
        priority: "high",
        recipientHrId: entry.managerHrId,
        title: many ? `${people.length} CVs are waiting unopened in your folders` : "A CV is waiting unopened in your folders",
      });
    } catch (error) {
      result.failed += 1;
      logError("A manager CV folder reminder could not be sent", {
        error,
        labels: { event: "manager_cv_reminder_failed" },
      });
    }
  }

  return result;
}
