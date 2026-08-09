// Telling the District Manager a fortnight is waiting on him.
//
// Recipients are the owner's decision (2026-08-08): the DM is the To, and his National Sales
// Manager and Regional Manager are copied so the chain can see a recommendation is pending before
// it is approved. They are passed EXPLICITLY rather than resolved by strategy, and through
// createSystemNotificationForRecipients rather than a per-recipient loop — looping bypasses
// envelope consolidation and sends N separate emails to the same thread.

import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey, normalizeHrIdForAccess } from "@/lib/hr-id";
import { logError } from "@/lib/observability/log";
import type { EarlyBirdsPendingCandidate } from "@/lib/early-birds/decisions";
import { earlyBirdsReasonSummary } from "@/lib/early-birds/decisions";
import { formatStartClock } from "@/components/early-birds/early-birds-format";

const EARLY_BIRDS_ACTION_URL = "/employee-portals/approvals/early-bird";

/**
 * The manager, then his manager, then his manager's manager — capped at two rungs above, which on
 * this org chart is the Regional and then the National Sales Manager. Depth-capped because a
 * directory cycle would otherwise loop.
 */
async function resolveChainRecipients(managerHrId: string): Promise<string[]> {
  const rows = await getEmployeeDirectoryRows().catch(() => []);
  const byKey = new Map(rows.map((row) => [normalizeHrIdForAccess(row.hrId) ?? "", row] as const));

  const recipients: string[] = [];
  const seen = new Set<string>();

  let cursor: string | null = managerHrId;
  for (let rung = 0; rung < 3 && cursor; rung += 1) {
    const key = normalizeHrIdForAccess(cursor);
    if (!key || seen.has(key)) break;
    seen.add(key);
    const row = byKey.get(key);
    if (!row) break;
    recipients.push(row.hrId);
    cursor = row.managerHrId;
  }

  return recipients;
}

/**
 * Never throws. A notification that cannot be delivered must not roll back a snapshot that was
 * already written — the recommendation still exists in the Approvals Hub either way.
 */
/**
 * The evidence, as label/value rows.
 *
 * These become `metadataRows` in the house email layout, which renders them as the premium
 * zebra-striped table (`renderPhoenixMetadataTable`) — striping applied INLINE, because email
 * clients routinely drop `<style>` and almost none honour `:nth-child`. Reusing that component
 * rather than hand-rolling a table is what keeps this email looking like every other Phoenix one.
 *
 * Order matters: who, then where, then the numbers that justify it, then who he beat. A manager
 * should be able to approve or reject from the email body alone without opening the board.
 */
function buildEarlyBirdsEmailMetrics(candidate: EarlyBirdsPendingCandidate) {
  const rows: Array<{ label: string; value: string | number }> = [
    { label: "Recommended", value: candidate.employeeName },
    { label: "Area", value: candidate.areaName ?? "—" },
    { label: "Fortnight", value: candidate.periodLabel },
    { label: "Median first visit", value: formatStartClock(candidate.medianStartMinutes) },
    { label: "Days submitted", value: `${candidate.daysWithSubmission} of ${candidate.expectedWorkingDays}` },
    // Stated explicitly: the ranking mixes GPS check-ins with rep-controlled save times, and a
    // manager approving an award deserves to see which this rests on.
    {
      label: "GPS-verified visits",
      value: `${candidate.gpsVerifiedVisits} of ${candidate.gpsEligibleVisits}`,
    },
    { label: "Regular visits", value: candidate.regularVisits },
    { label: "Days finished first", value: candidate.dailyWins },
    { label: "Score", value: `${Math.round(candidate.totalScore * 1000)} / 1000` },
  ];

  if (candidate.candidateRank > 1) {
    // A second or third recommendation must explain itself, or it reads as the system changing
    // its mind.
    rows.push({ label: "Rank offered", value: `#${candidate.candidateRank}` });
  }
  for (const [index, runner] of candidate.runnersUp.slice(0, 3).entries()) {
    rows.push({
      label: index === 0 ? "Next best" : `Then`,
      value: `${runner.name} — ${formatStartClock(runner.medianStartMinutes)} · ${Math.round(runner.totalScore * 1000)} pts`,
    });
  }
  for (const rejected of candidate.rejectedSoFar.slice(0, 3)) {
    rows.push({ label: "Already rejected", value: `${rejected.name}${rejected.reason ? ` — ${rejected.reason}` : ""}` });
  }

  return rows;
}

export async function notifyEarlyBirdsRecommendation(candidate: EarlyBirdsPendingCandidate): Promise<void> {
  try {
    const recipients = await resolveChainRecipients(candidate.managerHrId);
    if (recipients.length === 0) return;

    const deduped = Array.from(
      new Map(recipients.map((hrId) => [canonicalHrIdKey(hrId) ?? hrId, hrId])).values(),
    );

    await createSystemNotificationForRecipients(
      {
        category: "early_bird_recommendation",
        module: "early_birds",
        eventType: "recommendation_pending",
        priority: "normal",
        actionUrl: EARLY_BIRDS_ACTION_URL,
        title: `Early Bird — ${candidate.periodLabel}`,
        message:
          `${candidate.employeeName} is your recommended Early Bird for ${candidate.periodLabel}.\n\n` +
          `${earlyBirdsReasonSummary(candidate)}.\n\n` +
          `The full evidence is below. Confirm him, or reject with a reason and the next-ranked rep ` +
          `is offered instead.`,
        // Renders as the house zebra-striped details table.
        email: { metrics: buildEarlyBirdsEmailMetrics(candidate) },
        metadata: {
          employeeHrId: candidate.employeeHrId,
          earlyBirdsSnapshotId: candidate.snapshotId,
          earlyBirdsPeriodKey: candidate.periodKey,
          // Per-recipient suffix is added downstream; the key identifies the recommendation so a
          // re-run cannot double-notify for the same fortnight and candidate.
          idempotencyKey: `early_birds:${candidate.snapshotId}:${candidate.candidateId}:pending`,
        },
      },
      deduped,
    );
  } catch (error) {
    logError("Early Birds recommendation notification failed", {
      labels: {
        event: "early_birds_notify_failed",
        snapshot: candidate.snapshotId,
        period: candidate.periodKey,
      },
      error,
    });
  }
}
