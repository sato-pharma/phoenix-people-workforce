import { summarizeNotificationMonitoring } from "@/lib/communication/metrics";
import { addDaysToDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { resolveNotificationRecipientsWithGovernance } from "@/lib/notifications/policy";
import {
  canViewerSeeNotification,
  isPersonalBellCategory,
  PERSONAL_BELL_CATEGORIES,
} from "@/lib/notifications/recipients";
import { formatCount, formatList } from "@/lib/reconciliation/compare";
import { partitionLoginsWithoutEmployeeRow } from "@/lib/reconciliation/logins-without-employee-row";
import type { ReconciliationCheck, ReconciliationOutcome } from "@/lib/reconciliation/types";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";

type SentInAppDeliveryRow = {
  id: string;
  recipient_hr_id: string | null;
  notification_event_id: string | null;
  notification_events: {
    category: string | null;
    employee_hr_id: string | null;
    recipients: unknown;
    created_at: string | null;
    module: string | null;
  } | null;
};

/**
 * Every delivery the ledger claims actually reached a person's bell.
 *
 * Paginated: there are ~2,200 of these and PostgREST caps a response at 1,000, so an unpaginated
 * read would silently drop the newest third — and a check that cannot see the newest rows reports
 * green precisely when a fresh regression starts.
 */
async function loadSentInAppDeliveries(): Promise<SentInAppDeliveryRow[]> {
  return fetchAllRows<SentInAppDeliveryRow>(
    () =>
      getSupabaseAdmin()
        .from("notification_deliveries")
        .select(
          "id,recipient_hr_id,notification_event_id,notification_events(category,employee_hr_id,recipients,created_at,module)",
        )
        .eq("channel", "in_app")
        .eq("status", "sent"),
    "id",
  );
}

function cairoTimestamp(iso: string | null | undefined): string {
  if (!iso) return "unknown time";
  return `${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo",
  }).format(new Date(iso))} Cairo`;
}

/**
 * Check 13 — every in_app delivery recorded as "sent" is a category the bell can render.
 *
 * listInAppNotificationsForViewer applies isPersonalBellCategory twice — once as a SQL filter and
 * once in memory — so a category outside PERSONAL_BELL_CATEGORIES can never appear in anyone's
 * bell, no matter what the delivery ledger says. Direct-order approvals are written as in_app
 * "sent" under a category the bell does not carry, so the approver is told nothing while
 * monitoring reports a 100% success rate. A total outage that announces itself as green is the
 * worst shape in this codebase, which is why the tolerance here is zero: one row is one human
 * told nothing.
 */
const sentInAppMustBeBellRenderable: ReconciliationCheck = {
  id: "in-app-sent-must-be-bell-renderable",
  title: 'Every in_app delivery recorded as "sent" must be a category the bell can actually render',
  domain: "notifications-integrity",
  severity: "critical",
  expectation: "known-open",
  openDefect:
    "Verified on production 2026-08-04: 23 of 2,232 in_app 'sent' deliveries carry a category the bell cannot render — direct_order_request (11, addressed to real approvers on 2026-08-03), high_risk_digest (8) and telegram_connection_linked (4). The bell allowlist is vacation_request, probation, coaching_report, general, internal_message, excuse, recruitment.",
  async run(): Promise<ReconciliationOutcome> {
    const deliveries = await loadSentInAppDeliveries();
    const categories = new Map<string, { count: number; newest: SentInAppDeliveryRow | null }>();
    for (const delivery of deliveries) {
      const category = String(delivery.notification_events?.category ?? "").trim() || "(no category)";
      const entry = categories.get(category) ?? { count: 0, newest: null };
      entry.count += 1;
      const newestAt = entry.newest?.notification_events?.created_at ?? "";
      if ((delivery.notification_events?.created_at ?? "") >= newestAt) entry.newest = delivery;
      categories.set(category, entry);
    }

    const unrenderable = [...categories.entries()].filter(([category]) => !isPersonalBellCategory(category));

    return {
      left: {
        source: "PERSONAL_BELL_CATEGORIES — the allowlist listInAppNotificationsForViewer filters on, twice",
        value: PERSONAL_BELL_CATEGORIES.join(", "),
      },
      right: {
        source: "distinct categories across in_app deliveries recorded as 'sent'",
        value: [...categories.keys()].sort().join(", ") || "none",
      },
      holds: unrenderable.length === 0,
      detail:
        unrenderable.length === 0
          ? `All ${formatCount(deliveries.length, "in-app delivery")} marked sent belong to a category the bell renders.`
          : formatList(
              unrenderable.map(
                ([category, entry]) =>
                  `${category}: ${formatCount(entry.count, "delivery", "deliveries")} recorded as sent that no bell can show, newest ${cairoTimestamp(entry.newest?.notification_events?.created_at)}`,
              ),
            ),
    };
  },
};

/**
 * Check 14 — one fanout delivers at most one copy per person, not one per login account.
 *
 * The resolver's dedupe key is `recipient.userId || recipient.hrId || recipient.email` — login id
 * FIRST — and candidates come from activeAuthCandidates(), which emits one candidate per auth
 * ACCOUNT. Two logins for one person therefore survive dedupe as two distinct recipients, and that
 * human receives every system notification twice, forever, with nothing to announce it.
 *
 * A login with no HR_ID at all breaches only when `partitionLoginsWithoutEmployeeRow` does not
 * account for it: this check is scheduled nightly, and a check that alarms every night on a
 * condition ruled permanent is one nobody reads within a week — including on the night it is
 * telling the truth.
 *
 * The probe uses a real production event shape (attendance's ingestion-stalled alert, whose
 * strategy is permission_based and therefore walks the full active-account list). It reads only.
 */
const fanoutHasNoDuplicateHuman: ReconciliationCheck = {
  id: "notification-fanout-has-no-duplicate-human",
  title: "One notification fanout delivers at most one copy per person, not one per login account",
  domain: "notifications-integrity",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id")
      .eq("is_active", true);
    if (error) throw new Error(`Active login read failed: ${error.message}`);
    const accounts = (data ?? []) as Array<{ login_id: string | null; hr_id: string | null }>;

    const byHuman = new Map<string, string[]>();
    for (const account of accounts) {
      const human = String(account.hr_id ?? "").trim().toUpperCase();
      if (!human) continue;
      byHuman.set(human, [...(byHuman.get(human) ?? []), String(account.login_id ?? "").trim()]);
    }
    const sharedHrIds = [...byHuman.entries()].filter(([, logins]) => logins.length > 1);
    const loginsWithoutHuman = accounts
      .filter((account) => !String(account.hr_id ?? "").trim())
      .map((account) => String(account.login_id ?? "").trim())
      .filter(Boolean);
    const { explained: explainedWithoutHuman, unexplained: unexplainedWithoutHuman } =
      partitionLoginsWithoutEmployeeRow(loginsWithoutHuman);

    // The probe needs a real subject: permissionBasedRecipients returns nobody at all when there
    // is no subject to scope against, which would make this check quietly vacuous.
    const subjectHrId = [...byHuman.keys()].sort()[0] ?? null;
    let resolvedCount = 0;
    let resolvedHumans = 0;
    let probeDuplicates: string[] = [];
    if (subjectHrId) {
      const resolution = await resolveNotificationRecipientsWithGovernance({
        eventType: "attendance_agent_ingestion_stalled",
        module: "attendance",
        subjectHrId,
      });
      resolvedCount = resolution.recipients.length;
      const hrIds = resolution.recipients.map((recipient) => String(recipient.hrId ?? "").trim().toUpperCase());
      resolvedHumans = new Set(hrIds.filter(Boolean)).size;
      const counted = new Map<string, number>();
      for (const hrId of hrIds) counted.set(hrId, (counted.get(hrId) ?? 0) + 1);
      probeDuplicates = [...counted.entries()]
        .filter(([hrId, count]) => hrId && count > 1)
        .map(([hrId, count]) => `${hrId} would receive ${count} copies of one notification`);
    }

    const problems: string[] = [];
    for (const [human, logins] of sharedHrIds) {
      problems.push(`${human} holds ${formatCount(logins.length, "active login")} (${logins.join(", ")}) — every system notification reaches them once per login`);
    }
    if (unexplainedWithoutHuman.length > 0) {
      problems.push(
        `${formatCount(unexplainedWithoutHuman.length, "active login")} carry no HR_ID (${unexplainedWithoutHuman.join(", ")}), so their deliveries can never be attributed to a person`,
      );
    }
    problems.push(...probeDuplicates);

    // Named even when everything holds: an exception nobody can see stops being an exception and
    // becomes a silent hole, and the next reader has no way to tell the two apart.
    const explained =
      explainedWithoutHuman.length === 0
        ? ""
        : ` Carrying no HR_ID by design, and excluded: ${explainedWithoutHuman
            .map(({ login, reason }) => `${login} — ${reason}`)
            .join("; ")}.`;

    return {
      left: {
        source: "resolveNotificationRecipientsWithGovernance for a permission-based system fanout",
        value: `${formatCount(resolvedCount, "recipient")} covering ${formatCount(resolvedHumans, "person", "people")}`,
      },
      right: {
        source: "app_auth_users where is_active — accounts vs distinct HR_IDs",
        value: `${formatCount(accounts.length, "active login")} covering ${formatCount(byHuman.size, "person", "people")}`,
      },
      holds: problems.length === 0,
      detail:
        problems.length === 0
          ? `${formatCount(accounts.length, "active login")} map one-to-one onto ${formatCount(byHuman.size, "person", "people")}, and the resolver returns one recipient per person.${explained}`
          : `${formatList(problems)}${explained}`,
    };
  },
};

/**
 * Check 15 — nothing is past its due date while the monitoring screen reports nothing pending.
 *
 * pending24h only counts events CREATED in the last 24 hours, so a reminder created in June and
 * due today is invisible to the Communication Center: the dashboard keeps reading 0 while the
 * queue backs up. The 5-minute processor that drains this queue has died before — the entire
 * scheduler stopped once — and the crons now live on a free third-party service outside this repo.
 *
 * The bar is "due since YESTERDAY or earlier", not "due today". Production writes almost every
 * event already due — 47 of 47 on 2026-08-03, 92 of 92 on 2026-08-02 carry a scheduled_for at or
 * before their own creation date — and they sit as `pending` until the 5-minute processor picks
 * them up. `scheduled_for <= today` would therefore flag any event created in the minutes before
 * this check runs, which at ~90 events a day and a 2.5-minute average wait is roughly one spurious
 * page every six nights. An event still pending a full day after it came due cannot be explained
 * by a late tick, so only a genuinely stalled processor can trip this.
 */
const noDueScheduledNotificationLeftUnprocessed: ReconciliationCheck = {
  id: "no-due-scheduled-notification-left-unprocessed",
  title: "No scheduled notification is past its due date while the monitoring screen reports nothing pending",
  domain: "notifications-integrity",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const supabase = getSupabaseAdmin();
    const sinceIso = new Date(Date.now() - 24 * 3_600_000).toISOString();
    // Cairo, matching todayDateOnly() in probation/service.ts — the drainer's own boundary. A UTC
    // boundary here would call events due at a different moment than the processor does.
    const today = currentCairoDateOnlyIso();
    const dueBefore = addDaysToDateOnly(today, -1) ?? today;

    const [recentEvents, dueEvents] = await Promise.all([
      supabase.from("notification_events").select("created_at,status").gte("created_at", sinceIso),
      supabase
        .from("notification_events")
        .select("id,category,scheduled_for,created_at")
        .in("status", ["pending", "scheduled"])
        .lte("scheduled_for", dueBefore),
    ]);
    if (recentEvents.error) throw new Error(`Recent notification events read failed: ${recentEvents.error.message}`);
    if (dueEvents.error) throw new Error(`Due notification events read failed: ${dueEvents.error.message}`);

    const monitoring = summarizeNotificationMonitoring({
      notificationEvents: ((recentEvents.data ?? []) as Array<{ created_at?: string | null; status?: string | null }>).map(
        (row) => ({
          createdAt: typeof row.created_at === "string" ? row.created_at : null,
          status: typeof row.status === "string" ? row.status : null,
        }),
      ),
      sinceIso,
    });
    const overdue = (dueEvents.data ?? []) as Array<{ category: string | null; scheduled_for: string | null }>;

    return {
      left: {
        source: "summarizeNotificationMonitoring(...) — what the Communication Center shows",
        value: `${formatCount(monitoring.pending24h, "pending event")} of ${formatCount(monitoring.totalQueuedEvents, "event")} queued in the last 24h`,
      },
      right: {
        source: `notification_events with status pending/scheduled and scheduled_for <= ${dueBefore} — the set the processor should have drained a day ago`,
        value: formatCount(overdue.length, "event past its due date"),
      },
      holds: overdue.length === 0,
      detail:
        overdue.length === 0
          ? `Nothing is past its due date; the queue drain is keeping up (${formatCount(monitoring.totalQueuedEvents, "event")} created in the last 24h).`
          : `The monitoring screen shows ${formatCount(monitoring.pending24h, "pending event")} while ${formatCount(overdue.length, "event")} are already due and unprocessed: ${formatList(overdue.map((row) => `${row.category ?? "uncategorised"} due ${row.scheduled_for ?? "unknown"}`))}`,
    };
  },
};

/**
 * Check 16 — every in_app delivery recorded as "sent" names a recipient the bell's own visibility
 * rule admits.
 *
 * Row-level counterpart to check 13: that one asks whether the CATEGORY can be rendered, this one
 * asks whether the addressed PERSON could ever see it. canViewerSeeNotification is the single
 * fail-closed decision the bell applies in listInAppNotificationsForViewer, markInAppNotificationRead
 * and archiveInAppNotification, so a delivery it rejects is unreachable in the UI forever while the
 * ledger records it as a success. Nothing else in the system compares these two sides.
 */
const sentInAppRecipientMustBeAbleToSeeIt: ReconciliationCheck = {
  id: "in-app-sent-recipient-must-be-able-to-see-it",
  title: 'Every in_app delivery recorded as "sent" names a recipient the bell\'s own visibility rule admits',
  domain: "notifications-integrity",
  severity: "critical",
  expectation: "known-open",
  openDefect:
    "Verified on production 2026-08-04: 9 of 2,232 rows fail. Eight from 2026-06-23..29 (weekly_plans, support_requests) carry no employee_hr_id and empty recipients, identifying the recipient only by a login id — no viewer can ever see them. One from 2026-07-20 (holiday_confirmation) produced two in-app deliveries from an event naming a single person, so the second copy is invisible. The writers have emitted 2,223 consecutive clean rows since, so this is stale history awaiting a one-off backfill rather than an active regression.",
  async run(): Promise<ReconciliationOutcome> {
    const deliveries = await loadSentInAppDeliveries();
    const invisible = deliveries.filter(
      (delivery) =>
        !canViewerSeeNotification(delivery.recipient_hr_id, {
          employeeHrId: delivery.notification_events?.employee_hr_id ?? null,
          recipients: delivery.notification_events?.recipients,
        }),
    );

    return {
      left: {
        source: "canViewerSeeNotification(delivery.recipient_hr_id, event) — the bell's own fail-closed rule",
        value: `${formatCount(deliveries.length - invisible.length, "delivery", "deliveries")} the recipient can actually open`,
      },
      right: {
        source: "notification_deliveries where channel = in_app and status = sent",
        value: `${formatCount(deliveries.length, "delivery", "deliveries")} the ledger claims reached someone`,
      },
      holds: invisible.length === 0,
      detail:
        invisible.length === 0
          ? `All ${formatCount(deliveries.length, "in-app delivery")} marked sent name a recipient who can open them.`
          : formatList(
              invisible.map(
                (delivery) =>
                  `${delivery.notification_events?.module ?? "unknown module"} delivery to "${delivery.recipient_hr_id ?? "no recipient"}" on ${cairoTimestamp(delivery.notification_events?.created_at)} is recorded as sent but no viewer can open it`,
              ),
            ),
    };
  },
};

export const notificationsIntegrityReconciliationChecks: ReconciliationCheck[] = [
  sentInAppMustBeBellRenderable,
  fanoutHasNoDuplicateHuman,
  noDueScheduledNotificationLeftUnprocessed,
  sentInAppRecipientMustBeAbleToSeeIt,
];
