/**
 * Telegram messages that are being thrown away, and nothing says so.
 *
 * A Telegram delivery whose recipient has no live link is written `status: "skipped"` with
 * `last_error: "Telegram is not connected."` — the SAME word used when a module policy deliberately
 * turns the channel off. A dead link and a decision are therefore indistinguishable in the data, so
 * nothing has ever gone red about one.
 *
 * Measured on production 2026-09-28: **not one link in the company was active** — 10 `pending`, 1
 * `failed`, 0 `active` — and **1,656 messages had been dropped that way, 311 of them in the last
 * seven days**. The worst hit were the people the alerts exist for: the CEO (448), the SFE Manager
 * (234), the National Sales Manager (189). Every one of those was a notification somebody had
 * decided was worth sending.
 *
 * 🔴 IT ALERTS ON LIVE LOSS, NOT ON A LIST OF BROKEN LINKS. A person who is not being sent anything
 * needs no alarm, and a permanent list of stale links is the kind of thing that is muted in a week.
 * So it looks only at what was dropped in the last `WINDOW_HOURS`: the moment the links are fixed it
 * falls silent on its own, with nothing to remember and nothing to stand down.
 *
 * 🔴 IN-APP ONLY, and the reason is the whole point: the channel this is about is dead. Sending the
 * "your Telegram is not working" notice over Telegram would be swallowed by exactly the fault it
 * reports. Email is not used either — the owner's standing rule keeps this system off real outbound
 * email, and the Super Admin reads the bell.
 *
 * It rides `/api/notifications/daily` rather than taking a schedule: a `JOB_SCHEDULES` declaration
 * whose cron job does not exist reads to `job-heartbeat-assess` as a job that has STOPPED and
 * Telegrams every Super Admin for ever (AGENTS.md §4).
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The exact sentence the Telegram sender writes when the recipient has no live link. */
export const NOT_CONNECTED_ERROR = "Telegram is not connected." as const;

/** Only losses this recent count: the alert is about messages being thrown away NOW. */
export const WINDOW_HOURS = 24;

/** Below this, one person's handful of drops is not worth a Super Admin's morning. */
export const MIN_DROPPED = 3;

/**
 * The Super Admin. Deliberately the EXISTING system-health audience rather than a new registry key:
 * this is the same kind of fact by the same route, and retargeting one should retarget the other.
 */
export const DEAD_TELEGRAM_AUDIENCE = "weekly_system_health_digest" as const;

export type DeadTelegramLinkRun = {
  dropped: number;
  people: number;
  delivered: number;
  skippedReason: string | null;
};

export type DroppedFor = { hrId: string; dropped: number };

/** Who lost Telegram messages in the window, worst first. */
export function rollUpDrops(rows: ReadonlyArray<{ recipient_hr_id?: string | null }>): DroppedFor[] {
  const byPerson = new Map<string, number>();
  for (const row of rows) {
    const hrId = String(row.recipient_hr_id ?? "").trim().toUpperCase();
    if (!hrId) continue;
    byPerson.set(hrId, (byPerson.get(hrId) ?? 0) + 1);
  }
  return [...byPerson]
    .map(([hrId, dropped]) => ({ hrId, dropped }))
    .filter((entry) => entry.dropped >= MIN_DROPPED)
    .sort((left, right) => right.dropped - left.dropped || left.hrId.localeCompare(right.hrId));
}

/** The words. Names and counts, then the one sentence that says why it is invisible. */
export function alertMessage(people: ReadonlyArray<DroppedFor & { name: string; linkStatus: string }>): string {
  const total = people.reduce((sum, person) => sum + person.dropped, 0);
  return [
    `${total} Telegram ${total === 1 ? "message was" : "messages were"} thrown away in the last ${WINDOW_HOURS} hours because the ${people.length === 1 ? "person has" : "people have"} no working Telegram link.`,
    "",
    ...people.map((person) => `• ${person.name} — ${person.dropped} dropped — link is ${person.linkStatus}`),
    "",
    "Nothing else reports this. The delivery is recorded as \"skipped\", which is the same word used when a channel is deliberately switched off, so a dead link and a decision look identical and neither turns anything red.",
    "",
    "Each person fixes it by linking Telegram again from their own profile.",
  ].join("\n");
}

async function namesAndLinkStatus(hrIds: ReadonlyArray<string>): Promise<Map<string, { name: string; linkStatus: string }>> {
  const supabase = getSupabaseAdmin();
  const [people, links] = await Promise.all([
    supabase.from("employees").select("hr_id, full_name").in("hr_id", [...hrIds]),
    supabase.from("telegram_connections").select("hr_id, status, created_at").in("hr_id", [...hrIds]),
  ]);
  const names = new Map<string, string>();
  for (const row of (people.data ?? []) as Array<{ hr_id?: string | null; full_name?: string | null }>) {
    const key = String(row.hr_id ?? "").trim().toUpperCase();
    if (key) names.set(key, String(row.full_name ?? key));
  }
  // Newest row per person wins: a re-link attempt leaves the earlier row behind.
  const statuses = new Map<string, { status: string; at: string }>();
  for (const row of (links.data ?? []) as Array<{ hr_id?: string | null; status?: string | null; created_at?: string | null }>) {
    const key = String(row.hr_id ?? "").trim().toUpperCase();
    if (!key) continue;
    const at = String(row.created_at ?? "");
    const held = statuses.get(key);
    if (!held || at > held.at) statuses.set(key, { status: String(row.status ?? "unknown"), at });
  }
  const out = new Map<string, { name: string; linkStatus: string }>();
  for (const hrId of hrIds) {
    const key = hrId.toUpperCase();
    out.set(key, {
      name: names.get(key) ?? key,
      // "never linked" is a different problem from "linked and broken", and the fix differs.
      linkStatus: statuses.get(key)?.status ?? "never linked",
    });
  }
  return out;
}

/** One pass. Never throws: it runs beside the other daily nudges and must not take them down. */
export async function runDeadTelegramLinkAlert(): Promise<DeadTelegramLinkRun> {
  try {
    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    // Paged, every dropped message of the window: the alert counts them, and a cut read would under-count.
    const supabase = getSupabaseAdmin();
    const data = await fetchAllRows<{ recipient_hr_id?: string | null }>(
      () =>
        supabase
          .from("notification_deliveries")
          .select("recipient_hr_id")
          .eq("channel", "telegram")
          .eq("last_error", NOT_CONNECTED_ERROR)
          .gte("created_at", since),
      "id",
    );

    const people = rollUpDrops(data);
    // The good outcome: every link that is being written to is working.
    if (people.length === 0) return { dropped: 0, people: 0, delivered: 0, skippedReason: "nothing_dropped" };

    const detail = await namesAndLinkStatus(people.map((entry) => entry.hrId));
    const described = people.map((entry) => ({
      ...entry,
      name: detail.get(entry.hrId)?.name ?? entry.hrId,
      linkStatus: detail.get(entry.hrId)?.linkStatus ?? "unknown",
    }));

    const { recipients, warnings } = await resolveNotificationPersonRecipients(DEAD_TELEGRAM_AUDIENCE, "dead telegram link alert");
    for (const warning of warnings) logError("Dead Telegram link alert recipient warning", { labels: { event: "dead_telegram_link_recipients" }, error: warning });
    const hrIds = recipients.map((person) => person.hrId).filter((hrId): hrId is string => Boolean(hrId));
    const dropped = described.reduce((sum, person) => sum + person.dropped, 0);
    if (hrIds.length === 0) return { dropped, people: described.length, delivered: 0, skippedReason: "no_recipients" };

    await createSystemNotificationForRecipients(
      {
        actionUrl: "/admin/notifications/telegram",
        category: "system",
        // In-app ALONE. The channel this is about is the broken one — see the header.
        channels: ["in_app"],
        eventType: "dead_telegram_link_alert",
        message: alertMessage(described),
        metadata: { idempotencyKey: `telegram:dead-links:${currentCairoDateOnlyIso()}` },
        module: "system",
        priority: "normal",
        title: `${dropped} Telegram ${dropped === 1 ? "message" : "messages"} thrown away in the last ${WINDOW_HOURS} hours`,
      },
      hrIds,
    );

    return { dropped, people: described.length, delivered: hrIds.length, skippedReason: null };
  } catch (error) {
    logError("Dead Telegram link alert failed", { labels: { event: "dead_telegram_link_failed" }, error });
    return { dropped: 0, people: 0, delivered: 0, skippedReason: "error" };
  }
}
