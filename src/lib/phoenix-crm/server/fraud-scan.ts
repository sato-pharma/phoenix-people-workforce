/**
 * Phoenix CRM — the weekly visit-fraud scan, sent.
 *
 * The I/O half of `src/lib/phoenix-crm/fraud-scan-rules.ts`. Owner, 2026-10-07: once a week, the
 * integrity board's flags for the completed Sat–Wed week, to the Super Admin and the SFE Managers,
 * in-app and Telegram.
 *
 * It judges nothing of its own — see the rules file. It never reads the evidence table: the week
 * arrives from the board's own reader (`loadIntegrityCasesForWindow`), which stays the SINGLE reader
 * of it, and this file only summarises what comes back. No detector re-runs here and no threshold
 * lives here. The table is deliberately not spelled out anywhere in this file — check 5 of
 * `tests/phoenix-crm-blind-half.test.ts` reads raw source, so naming it here would declare a read
 * that does not happen.
 *
 * ## Two tiers, one read
 *
 * The position (GPS) cases are the Super Admin's alone (owner, 2026-10-02), and so are the signboard
 * and capture-trust cases (owner, 2026-10-09). So the week is read ONCE, with everything, for the
 * Super Admin, and the SFE's copy is that same list kept to the cases the board's reader stamped as
 * his (`sfeVisibleCases`) — never a second query that could drift from the first. A person who holds
 * both roles is given the Super Admin's wider view.
 *
 * 🔴 THE TIER IS DECIDED BY THE BOARD'S OWN `SFE_SOURCES`, NOT HERE AND NOT IN THE RULES FILE. One
 * read is only safe while the in-memory cut means exactly what the query would have meant: until
 * 2026-10-12 it did not — the cut was `source !== "gps"`, a subtraction, and every detector added
 * after `photo` was excluded from the SFE's copy by an accident of labelling rather than by the
 * decision. The row now carries `sfeVisible`, stamped from that one allow-list.
 *
 * ## Channels, and why it is never email or push
 *
 * In-app and Telegram, nothing else: `crm_fraud_scan` is on `PHOENIX_CRM_PUSH_BLOCKED_EVENT_TYPES`, so
 * the module guard strips email (as it does for the whole module) AND push, and shuts the
 * Telegram-failure fallback that would otherwise re-send as email/push to an admin whose Telegram is
 * not linked yet. It names its two channels at the call site too, so "only" is true both places.
 *
 * ## It sends on a clean week as well
 *
 * Unlike the 06:55 manager digest, a clean week IS reported — weekly, to two admin roles, a report
 * that only appears with bad news cannot be told apart from one that has silently stopped. A fire
 * that reaches nobody because no one holds the role is reported in the run, not swallowed.
 *
 * Never run from a laptop: it is a production cron, and a hand-run spends the week's idempotency key.
 */

import { currentCairoDateOnlyIso } from "@/lib/i18n/format";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import {
  fraudScanWindow,
  sfeVisibleCases,
  type FraudScanSummary,
  type FraudScanWindow,
} from "@/lib/phoenix-crm/fraud-scan-rules";
import { summarizeFraudCases } from "@/lib/phoenix-crm/server/fraud-scan-summary";
import { loadIntegrityCasesForWindow } from "@/lib/phoenix-crm/server/integrity-board";
import {
  PHOENIX_CRM_NOTIFICATION_CATEGORY,
  PHOENIX_CRM_NOTIFICATION_MODULE,
  PHOENIX_CRM_PORTAL_PATH,
  sfeManagerHrIds,
} from "@/lib/phoenix-crm/server/notifications";
import { mapWithConcurrency } from "@/lib/reconciliation/concurrency";

/** How many people are being sent the weekly report at once. */
const DELIVERIES_AT_ONCE = 4;

/**
 * Where the notice points: the module's own exceptions surface, exactly as the 06:55 digest does.
 * `PHOENIX_CRM_PORTAL_PATH` is the clean module's twin; the admin/portal twin forwarding routes each
 * recipient to their own shell (the Super Admin to `/admin/field-crm`, a portal manager to the portal
 * page), so one link serves both tiers. The retired pilot namespace is never linked — the clean
 * module stays isolated from it (tests/phoenix-crm-boundary.test.ts). The GPS detail stays
 * the Super Admin's alone through the message tiering above, not a separate destination.
 */
const EXCEPTIONS_PATH = `${PHOENIX_CRM_PORTAL_PATH}?tab=reports&section=exceptions`;

export type FraudScanDelivery = {
  hrId: string;
  summary: FraudScanSummary;
  /** The window end (YYYY-MM-DD) — the stable part of the per-week idempotency key. */
  weekKey: string;
};

export type PhoenixCrmFraudScanRun = {
  window: FraudScanWindow;
  /** Distinct recipients the scan addressed — Super Admins and SFE Managers, deduped. */
  recipients: number;
  /** Capture-level integrity flags in the week, across the whole field (the Super Admin's view). */
  flaggedVisits: number;
  strongVisits: number;
  delivered: number;
  failed: number;
  /** No one holds the Super Admin or SFE Manager role — the scan reached nobody, and says so. */
  noRecipients: boolean;
  /** Role-resolution problems (a departed holder, an unreadable accounts table), surfaced not hidden. */
  warnings: string[];
};

async function deliver(delivery: FraudScanDelivery): Promise<void> {
  await createSystemNotificationForRecipients(
    {
      actionUrl: EXCEPTIONS_PATH,
      category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
      // In-app and Telegram. The module guard strips email and push for this event type.
      channels: ["in_app", "telegram"],
      eventType: "crm_fraud_scan",
      message: delivery.summary.message,
      // Per recipient per WEEK: the cron can be retried or double-fired, and none of those may reach
      // anyone twice. Keyed on the window end, so a new week is a new notice and a retry of this one
      // is not — independent of the message text, which a late-arriving flag could still change.
      metadata: { idempotencyKey: `phoenix_crm:fraud_scan:${delivery.weekKey}:${delivery.hrId}` },
      module: PHOENIX_CRM_NOTIFICATION_MODULE,
      priority: "normal",
      subjectHrId: delivery.hrId,
      telegram: { ctaLabel: "Open the exceptions board", ctaUrl: EXCEPTIONS_PATH },
      title: delivery.summary.title,
    },
    [delivery.hrId],
  );
}

/**
 * One pass of the weekly scan. Never throws for a single failed delivery: one admin whose Telegram is
 * unlinked must not cost the others their report.
 */
export async function runPhoenixCrmFraudScan(
  send: (delivery: FraudScanDelivery) => Promise<void> = deliver,
): Promise<PhoenixCrmFraudScanRun> {
  const window = fraudScanWindow(currentCairoDateOnlyIso());

  const [superAdminRead, sfeHrIds, allCases] = await Promise.all([
    resolveHrIdsForRole("Super Admin", "Phoenix CRM — weekly fraud scan"),
    sfeManagerHrIds(),
    loadIntegrityCasesForWindow({ fromIso: window.fromIso, toIso: window.toIso, includeGps: true }),
  ]);

  const warnings = [...superAdminRead.warnings];
  // Test logins carry the mirrored person's HR id; they are never a real recipient (role-recipients
  // filters them for roles with no seat, and sfeManagerHrIds already drops TEST-).
  const superAdmins = superAdminRead.hrIds.filter((hrId) => !hrId.startsWith("TEST-"));

  // A person who holds both roles gets the wider Super Admin view, computed once.
  const tierByHrId = new Map<string, "super_admin" | "sfe">();
  for (const hrId of sfeHrIds) tierByHrId.set(hrId, "sfe");
  for (const hrId of superAdmins) tierByHrId.set(hrId, "super_admin");

  const superSummary = summarizeFraudCases(allCases, window);
  const sfeSummary = summarizeFraudCases(sfeVisibleCases(allCases), window);

  if (tierByHrId.size === 0) {
    return {
      window,
      recipients: 0,
      flaggedVisits: superSummary.flaggedVisits,
      strongVisits: superSummary.strongVisits,
      delivered: 0,
      failed: 0,
      noRecipients: true,
      warnings,
    };
  }

  // Several people at once rather than one after another (Phoenix CRM performance audit, 2026-10-16),
  // started in the same order. Each person is one entry of the map, so nobody is sent two. Every send
  // is still counted once, delivered or failed.
  let delivered = 0;
  let failed = 0;
  const recipients = [...tierByHrId].sort((left, right) => left[0].localeCompare(right[0]));
  await mapWithConcurrency(recipients, DELIVERIES_AT_ONCE, async ([hrId, tier]) => {
    try {
      await send({ hrId, summary: tier === "super_admin" ? superSummary : sfeSummary, weekKey: window.toIso });
      delivered += 1;
    } catch (error) {
      failed += 1;
      logError("Phoenix CRM fraud scan delivery failed", {
        labels: { event: "phoenix_crm_fraud_scan_failed", job: "phoenix-crm-fraud-scan" },
        error,
      });
    }
  });

  return {
    window,
    recipients: tierByHrId.size,
    flaggedVisits: superSummary.flaggedVisits,
    strongVisits: superSummary.strongVisits,
    delivered,
    failed,
    noRecipients: false,
    warnings,
  };
}
