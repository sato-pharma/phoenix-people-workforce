import { summarizeNotificationMonitoring } from "@/lib/communication/metrics";
import { addDaysToDateOnly } from "@/lib/date-only";
import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { identityGuardFailurePrefix } from "@/lib/notifications/email";
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

type IdentityGuardRejectionRow = {
  id: string;
  created_at: string | null;
  last_error: string | null;
  notification_events: {
    event_type: string | null;
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
  expectation: "holds",
  // Was known-open until 2026-10-23: every category written as an in_app delivery is on PERSONAL_BELL_CATEGORIES; the six that were missing were added and the 215 stranded rows now render.
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
 * That is not hypothetical. The allowance named `admin-HR` alone, so the 17 TEST ACCOUNTS — which
 * hold no HR_ID BY DESIGN — breached every morning at 04:40 from 30 Aug to 15 Oct 2026: 43
 * consecutive Telegram alerts to the owner for the design working as intended, each one the only
 * failing check out of 18. Widening the allowance to that named class is the fix; it is a class and
 * not a blanket, so a login outside both classes still pages, which is the whole point.
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
      .select("login_id,hr_id,is_test_persona")
      .eq("is_active", true);
    if (error) throw new Error(`Active login read failed: ${error.message}`);
    const accounts = (data ?? []) as Array<{
      login_id: string | null;
      hr_id: string | null;
      is_test_persona: boolean | null;
    }>;

    const byHuman = new Map<string, string[]>();
    for (const account of accounts) {
      const human = String(account.hr_id ?? "").trim().toUpperCase();
      if (!human) continue;
      byHuman.set(human, [...(byHuman.get(human) ?? []), String(account.login_id ?? "").trim()]);
    }
    const sharedHrIds = [...byHuman.entries()].filter(([, logins]) => logins.length > 1);
    const loginsWithoutHuman = accounts
      .filter((account) => !String(account.hr_id ?? "").trim())
      .map((account) => ({
        login: String(account.login_id ?? "").trim(),
        isTestPersona: account.is_test_persona,
      }))
      .filter((account) => Boolean(account.login));
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
    //
    // Grouped by reason rather than one line per login. The test-account class is 17 logins on
    // production, and repeating its sentence once per login put ~1,500 characters of identical
    // prose into a Telegram alert — which buries the breach it is standing next to. Every login is
    // still named in full: this collapses the REASONS, never the names (no ellipsis, §4).
    const reasonsInOrder: string[] = [];
    const loginsByReason = new Map<string, string[]>();
    for (const { login, reason } of explainedWithoutHuman) {
      if (!loginsByReason.has(reason)) {
        loginsByReason.set(reason, []);
        reasonsInOrder.push(reason);
      }
      loginsByReason.get(reason)?.push(login);
    }
    const explained =
      explainedWithoutHuman.length === 0
        ? ""
        : ` Carrying no HR_ID by design, and excluded: ${reasonsInOrder
            .map((reason) => `${(loginsByReason.get(reason) ?? []).join(", ")} — ${reason}`)
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
  expectation: "holds",
  // Was known-open until 2026-10-23: a recipient with no HR ID is recorded skipped, not sent, and a direct-order rung keeps its own event; the 622 stranded rows (386 with no HR ID, 236 overwritten) were repaired.
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

/**
 * Check 17 — the email identity guard refused nothing in the last 24 hours.
 *
 * The guard is correct and this check does not question it: refusing to send an official workflow
 * email whose data subject cannot be identified is the right behaviour, because the alternative is
 * mailing one employee's details under another employee's name. What was wrong is that a refusal
 * was INVISIBLE. It is written as `status = 'skipped'`, not `'failed'` — nothing alarms on skipped
 * and no dashboard counts it — so a caller that stopped naming its subject looked exactly like a
 * caller with nothing to send.
 *
 * Measured on production 2026-09-06: 159 official workflow emails refused across 68 days and 13
 * event types, and nobody knew. Had this check existed it would have fired on 30 June, the first
 * day, and on 24 separate days in August. The three live causes (a rep/manager mix-up in the
 * subject slot, a query that never selected the subject, and a digest with no single subject) were
 * fixed in #3354 and #3358, so the expected steady state is ZERO and this check should stay quiet.
 *
 * Quiet is the design goal, not a nice-to-have. A check that fires at the normal working level
 * becomes wallpaper — this repo has already watched a session-count warning sit at 9 for hours
 * with nobody acting on it. So this counts ONLY guard refusals, never `skipped` in general: the
 * common skips (`EMAIL_NOTIFICATIONS_ENABLED is not true`, `No active push subscription`) are
 * legitimate and would drown the signal from day one.
 */
async function loadRecentIdentityGuardRejections(): Promise<IdentityGuardRejectionRow[]> {
  // 24h, matching noDueScheduledNotificationLeftUnprocessed above. Paginated for the same reason
  // the in_app read is: PostgREST caps a response at 1,000 with no marker, and the run where that
  // matters is precisely the runaway regression this check exists to catch.
  const sinceIso = new Date(Date.now() - 24 * 3_600_000).toISOString();
  return fetchAllRows<IdentityGuardRejectionRow>(
    () =>
      getSupabaseAdmin()
        .from("notification_deliveries")
        .select("id,created_at,last_error,notification_events(event_type,module)")
        .eq("channel", "email")
        .eq("status", "skipped")
        .gte("created_at", sinceIso)
        // The guard's own prefix, imported rather than copied, so a reworded refusal cannot
        // silently empty this check and report green.
        .ilike("last_error", `${identityGuardFailurePrefix}%`),
    "id",
  );
}

const emailIdentityGuardRefusedNothing: ReconciliationCheck = {
  id: "email-identity-guard-refused-no-official-workflow-email",
  title: "No official workflow email was refused by the email identity guard in the last 24 hours",
  domain: "notifications-integrity",
  severity: "high",
  expectation: "holds",
  async run(): Promise<ReconciliationOutcome> {
    const rejections = await loadRecentIdentityGuardRejections();
    const cap = 10;

    return {
      left: {
        source: `notification_deliveries where channel = email, status = skipped and last_error starts "${identityGuardFailurePrefix}", last 24h`,
        value: `${formatCount(rejections.length, "official workflow email")} the guard refused to send`,
      },
      right: {
        source:
          "the standing expectation: a caller that cannot name the subject of its own email is a bug, so this set is empty",
        value: "0 refusals",
      },
      holds: rejections.length === 0,
      detail:
        rejections.length === 0
          ? "No official workflow email was refused for want of a subject identity in the last 24 hours."
          : `${formatList(
              rejections
                .slice(0, cap)
                .map(
                  (row) =>
                    `${row.notification_events?.event_type ?? "unknown event"} (${row.notification_events?.module ?? "unknown module"}) on ${cairoTimestamp(row.created_at)} — ${row.last_error ?? "no reason recorded"}`,
                ),
            )}${rejections.length > cap ? ` (first ${cap} of ${rejections.length})` : ""}`,
    };
  },
};

export const notificationsIntegrityReconciliationChecks: ReconciliationCheck[] = [
  sentInAppMustBeBellRenderable,
  fanoutHasNoDuplicateHuman,
  noDueScheduledNotificationLeftUnprocessed,
  sentInAppRecipientMustBeAbleToSeeIt,
  emailIdentityGuardRefusedNothing,
];
