/**
 * Production Planner — the reorder sweep that emails before a material runs out.
 *
 * The owner's reason for it, in his own words (2026-10-05): "ما انا كده هنسى" — he will forget, and
 * the ivy extract takes about six months to arrive, so a material that reaches one run of cover is
 * already late. This runs every morning, records what it found, and emails the people who can act.
 *
 * ── Four independent switches, every one fail-safe on its own ───────────────────────────────────
 *
 *  1. `prodplan_settings.alarm_enabled` must be explicitly `true` (alarm.ts's `resolveAlarmArming`).
 *  2. `prodplan_settings.alarm_dry_run` must be explicitly `false`.
 *  3. The `production_planning_reorder` template must be active — it ships inactive.
 *  4. `EMAIL_NOTIFICATIONS_ENABLED` must be on, which `sendTemplatedEmail` enforces for everything.
 *
 * None of them is a default: a missing settings row, a null column, or a read that half-failed all
 * land on "switched off, and sending nothing". Arming it is the owner's click, not a deployment.
 *
 * ── Why a disabled sweep answers `skipped` and not a zero ───────────────────────────────────────
 *
 * "0 sent" and "switched off" were indistinguishable during a 13-day outbox freeze, so this reports
 * which of the two it was. A DRY RUN is louder still: it writes exactly the rows a real run would,
 * with `dry_run = true` and `email_sent = false`, so he can read what WOULD have been sent before
 * arming anything. The table's own CHECK refuses `dry_run = true` beside `email_sent = true`, so a
 * bypassed gate fails at the database rather than in his inbox.
 */
import { renderPhoenixMetadataTable, renderPhoenixMetadataTableText } from "@/emails/phoenix-email-layout";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import { formatCoverRuns, type AlarmVerdict } from "./alarm";
import { formatQty, toDisplayQty } from "./rules";
import {
  evaluateReorderAlarms,
  loadProductionPlanningDataForSystem,
  PRODPLAN_TABLES,
  type ProductionPlanningData,
} from "./service";
import {
  ALARM_SEVERITY_LABELS,
  buildAlarmEmailSummary,
  buildAlarmRowValue,
  formatNumberLatin,
  PP,
  reorderEmailMaterialLabel,
} from "./strings";

export type ReorderSweepResult = {
  /** The Cairo date the verdict belongs to — a stock position is dated where the factory is. */
  readonly evaluatedOn: string;
  /** `"disabled"` when the owner has not armed it. Never a zero standing in for that. */
  readonly skipped: "disabled" | null;
  readonly dryRun: boolean;
  readonly alarms: number;
  readonly recorded: number;
  readonly emailSent: boolean;
  readonly emailSkippedReason: string | null;
  readonly warnings: string[];
};

/** Cairo, because a stock position dated "today" means today where the factory and the office are. */
function todayCairo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

function emailRows(verdicts: readonly AlarmVerdict[], data: ProductionPlanningData) {
  return verdicts.map((verdict) => {
    const material = data.materials.find((candidate) => candidate.id === verdict.materialId) ?? null;
    // In the unit he buys in — kilograms, not the grams the engine counts in.
    const held = material ? toDisplayQty(verdict.heldQty, material.basePerDisplay).text : formatQty(verdict.heldQty);
    return {
      // The packaging row is spelled out, because this email also says boxes for the product count.
      label: reorderEmailMaterialLabel(verdict.code, material?.nameAr ?? verdict.nameAr),
      value: buildAlarmRowValue({
        coverRuns: formatNumberLatin(formatCoverRuns(verdict.coverRunsMicro)),
        displayUnit: material?.displayUnit ?? "",
        heldText: formatNumberLatin(held),
        leadTimeDays: verdict.leadTimeDays === null ? null : formatNumberLatin(verdict.leadTimeDays),
        severityLabel: ALARM_SEVERITY_LABELS[verdict.severity],
      }),
    };
  });
}

export async function runProductionPlanningReorderSweep(): Promise<ReorderSweepResult> {
  const evaluatedOn = todayCairo();
  const warnings: string[] = [];
  const data = await loadProductionPlanningDataForSystem();

  const base: ReorderSweepResult = {
    alarms: 0,
    dryRun: data.settings.alarmDryRun,
    emailSent: false,
    emailSkippedReason: null,
    evaluatedOn,
    recorded: 0,
    skipped: null,
    warnings,
  };

  // Switch 1. Nothing is written either: a row dated today would read as "we looked and it was
  // fine", and we did not look.
  if (!data.settings.alarmEnabled) return { ...base, skipped: "disabled" };

  const { product, verdicts } = await evaluateReorderAlarms(data);
  if (!product) {
    warnings.push("No active product to evaluate.");
    return { ...base, warnings };
  }
  if (verdicts.length === 0) {
    await stampEvaluated(evaluatedOn, null);
    return { ...base, alarms: 0 };
  }

  const dryRun = data.settings.alarmDryRun;
  const db = getSupabaseAdmin();
  const rows = verdicts.map((verdict) => ({
    cover_runs: formatCoverRuns(verdict.coverRunsMicro),
    dry_run: dryRun,
    evaluated_on: evaluatedOn,
    held_qty: formatQty(verdict.heldQty),
    lead_time_days: verdict.leadTimeDays,
    material_id: verdict.materialId,
    needed_per_run_qty: formatQty(verdict.neededPerRunQty),
    product_id: product.id,
    threshold_runs: formatCoverRuns(verdict.thresholdRunsMicro),
    unit_kind: data.materials.find((candidate) => candidate.id === verdict.materialId)?.unitKind ?? "mass",
  }));

  // One row per material per Cairo day per mode (the table's own unique constraint), so a second run
  // the same morning updates the figures rather than stacking a second verdict beside them.
  const recordedRes = await db
    .from(PRODPLAN_TABLES.alarms)
    .upsert(rows, { onConflict: "material_id,evaluated_on,dry_run" })
    .select("id");
  if (recordedRes.error) {
    warnings.push(`Could not record the alarm events: ${recordedRes.error.message}`);
  }
  const recorded = recordedRes.data?.length ?? 0;

  // Switch 2. The rows above are the whole point of a dry run — he reads what would have been sent.
  if (dryRun) {
    await stampEvaluated(evaluatedOn, null);
    return { ...base, alarms: verdicts.length, dryRun: true, emailSkippedReason: "dry run", recorded, warnings };
  }

  const rowsForEmail = emailRows(verdicts, data);
  const worstCover = formatCoverRuns(verdicts[0]!.coverRunsMicro);
  // Switches 3 and 4 live inside sendTemplatedEmail: an inactive template and a disabled notification
  // environment both come back as `skipped` with a reason, which is reported rather than swallowed.
  const sent = await sendTemplatedEmail({
    context: {
      detailsTable: renderPhoenixMetadataTable(rowsForEmail),
      detailsTableText: renderPhoenixMetadataTableText(rowsForEmail),
      status: PP.alarmEmailStatus,
      subject: PP.alarmEmailSubject,
      summary: buildAlarmEmailSummary({
        count: formatNumberLatin(verdicts.length),
        productNameAr: product.nameAr,
      }),
    },
    // The Cairo date AND what the sweep actually found: a repeat run the same morning reaches nobody
    // twice, while a material that falls further tomorrow still gets through.
    idempotencyKey: `prodplan-reorder:${evaluatedOn}:${verdicts.length}:${worstCover}`,
    origin: { eventType: "production_reorder_alarm", module: "production_planning" },
    templateKey: "production_planning_reorder",
  });

  if (sent.skipped) {
    await stampEvaluated(evaluatedOn, null);
    return {
      ...base,
      alarms: verdicts.length,
      emailSkippedReason: sent.reason ?? "The email was not sent.",
      recorded,
      warnings,
    };
  }

  const markedRes = await db
    .from(PRODPLAN_TABLES.alarms)
    .update({ email_sent: true })
    .eq("evaluated_on", evaluatedOn)
    .eq("dry_run", false);
  if (markedRes.error) {
    // The email HAS gone; reporting that it did not would be the worse error, so this is a warning.
    warnings.push(`The email was sent but could not be marked: ${markedRes.error.message}`);
    logError("Production planner reorder sweep could not mark its rows", {
      labels: { event: "prodplan_alarm_mark_failed", job: "production-planning-reorder" },
      error: markedRes.error,
    });
  }
  await stampEvaluated(evaluatedOn, evaluatedOn);

  return { ...base, alarms: verdicts.length, emailSent: true, recorded, warnings };
}

/** When the sweep last looked, and when it last actually sent — two separate facts on purpose. */
async function stampEvaluated(evaluatedOn: string, sentOn: string | null) {
  const patch: Record<string, string> = { alarm_last_evaluated_on: evaluatedOn };
  if (sentOn !== null) patch.alarm_last_sent_on = sentOn;
  const { error } = await getSupabaseAdmin().from(PRODPLAN_TABLES.settings).update(patch).eq("id", 1);
  if (error) {
    logError("Production planner reorder sweep could not stamp the settings row", {
      labels: { event: "prodplan_alarm_stamp_failed", job: "production-planning-reorder" },
      error,
    });
  }
}
