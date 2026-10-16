import type { PhoenixRole } from "@/lib/auth/permissions";

/**
 * The recruitment alerts the Talent Acquisition seat no longer sees (owner, 2026-10-16: "in the ta
 * account notification center she should see 1 new cv received, 2 interview requests, 3 accepted
 * job offers").
 *
 * Her notification center holds exactly three notices, and every one of the event types below is
 * something else: the WhatsApp text-only and unreadable-CV alerts, the intake plumbing alarms, the
 * daily CV digest, the stale-send and triage-backlog escalations and the CVs returned by managers.
 * The senders stopped addressing her (`recruitmentDeskAlertRoles`), but the rows already written
 * stay in the newest-20 window the band reads, so this list also hides them on the way out.
 *
 * A DENY-list on purpose. The seat's bell also carries her own personal notices (a vacation
 * decision, an approval she raised), and an allow-list of the three would silently take those
 * from her. Each entry is an `event_type` written by a sender in `src/lib/recruitment/`.
 */
export const TALENT_ACQUISITION_HIDDEN_EVENT_TYPES: readonly string[] = [
  "recruitment_whatsapp_text_only",
  "recruitment_whatsapp_unreadable_cv",
  "recruitment_whatsapp_intake_unhealthy",
  "recruitment_inbound_intake_dead_letter",
  "recruitment_inbound_intake_spike",
  "recruitment_daily_cv_digest",
  "recruitment_stale_send_nudge",
  "recruitment_stale_send_stranded",
  "recruitment_triage_backlog",
  "recruitment_manager_hold_returned",
];

/** True when this notice is one the viewer's seat is deliberately not shown. Only that seat is touched. */
export function noticeHiddenFromSeat(role: PhoenixRole | null | undefined, eventType: string | null | undefined): boolean {
  if (role !== "HR Resourcing") return false;
  return TALENT_ACQUISITION_HIDDEN_EVENT_TYPES.includes(String(eventType ?? ""));
}

/**
 * How many rows the list reads from the database for this seat. The hidden rows are dropped AFTER
 * the read, so a seat that hides some must read past them or a week of WhatsApp alerts would leave
 * her band nearly empty. Everyone else reads exactly the limit they asked for.
 */
export function noticeFetchLimit(role: PhoenixRole | null | undefined, limit: number): number {
  return role === "HR Resourcing" ? Math.max(limit, 100) : limit;
}
