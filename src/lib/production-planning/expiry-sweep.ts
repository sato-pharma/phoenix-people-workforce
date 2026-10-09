/**
 * Production Planner — the expiry sweep that emails before a lot dies.
 *
 * The owner's reason, in his own words (2026-10-08): "مش اي اكسبيري ديت which is very important لان
 * انا عندي حاجات هتنتهي 4 27 فانا لازم انتبه لها" — he has material expiring in April 2027 and has to
 * be watching for it. He asked to be warned three months ahead, which is
 * `prodplan_settings.expiry_warn_days`.
 *
 * ── It runs INSIDE the reorder cron, deliberately ────────────────────────────────────────────────
 *
 * Not a second cron-job.org schedule. The production scheduler is cron-job.org and adding a job
 * there is the owner's own click in a console; folding this into the 06:10 pass he already has costs
 * him nothing and cannot drift out of step with the reorder verdict it sits beside. The two sweeps
 * are still separately ARMED — one can be live while the other is in dry run.
 *
 * ── The same four independent switches, each fail-safe on its own ────────────────────────────────
 *
 *  1. `prodplan_settings.expiry_alarm_enabled` must be explicitly `true` (`resolveExpiryArming`).
 *  2. `prodplan_settings.expiry_alarm_dry_run` must be explicitly `false`.
 *  3. The `production_planning_expiry` template must be active — it ships inactive.
 *  4. `EMAIL_NOTIFICATIONS_ENABLED` must be on, which `sendTemplatedEmail` enforces for everything.
 *
 * A disabled sweep answers `skipped: "disabled"` and writes NOTHING, because a row dated today would
 * read as "we looked and it was fine" and we did not look. A dry run writes exactly the rows a real
 * run would, with `dry_run = true` and `email_sent = false`, so he can read what WOULD have been
 * sent before arming anything — and the table's own CHECK refuses `dry_run = true` beside
 * `email_sent = true`, so a bypassed gate fails at the database rather than in his inbox.
 */
import { renderPhoenixDataGrid, renderPhoenixDataGridText } from "@/emails/phoenix-email-layout";
import { sendTemplatedEmail } from "@/lib/email-templates/service";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import type { ExpiryVerdict } from "./expiry";
import { formatQty, toDisplayQty } from "./rules";
import {
  evaluateExpiryForProduct,
  loadProductionPlanningDataForSystem,
  PRODPLAN_TABLES,
  type ProductionPlanningData,
} from "./service";
import {
  buildExpiryDaysNoteEn,
  buildExpiryEmailRow,
  buildExpiryEmailSummary,
  EXPIRY_EMAIL_COLUMNS,
  EXPIRY_SEVERITY_LABELS_EN,
  EXPIRY_SEVERITY_TONES,
  formatNumberLatin,
  nameEnglish,
  PP_EN,
  unitLabelEn,
} from "./strings";

export type ExpirySweepResult = {
  /** The Cairo date the verdict belongs to — a stock position is dated where the factory is. */
  readonly evaluatedOn: string;
  /** `"disabled"` when the owner has not armed it. Never a zero standing in for that. */
  readonly skipped: "disabled" | null;
  readonly dryRun: boolean;
  readonly lots: number;
  readonly recorded: number;
  readonly emailSent: boolean;
  readonly emailSkippedReason: string | null;
  readonly warnings: string[];
};

function todayCairo(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** One grid row per lot — ENGLISH, one column per fact (owner, 2026-10-09), like the reorder one. */
function emailRows(verdicts: readonly ExpiryVerdict[], data: ProductionPlanningData) {
  return verdicts.map((verdict) => {
    const material = data.materials.find((candidate) => candidate.id === verdict.materialId) ?? null;
    const location = data.locations.find((candidate) => candidate.id === verdict.locationId) ?? null;
    // In the unit he buys in — kilograms, not the grams the engine counts in.
    const held = material ? toDisplayQty(verdict.qty, material.basePerDisplay).text : formatQty(verdict.qty);
    return buildExpiryEmailRow({
      // Latin digits, and the ABSOLUTE day count — the phrase says which side of the date it is on.
      daysNote: buildExpiryDaysNoteEn(
        formatNumberLatin(Math.abs(verdict.daysLeft)),
        verdict.daysLeft < 0,
        verdict.daysLeft === 0,
      ),
      expiryDate: verdict.expiryDate,
      heldText: formatNumberLatin(held),
      locationName: location ? nameEnglish(location) : "",
      materialName: nameEnglish(material ?? verdict),
      severityLabel: EXPIRY_SEVERITY_LABELS_EN[verdict.severity],
      tone: EXPIRY_SEVERITY_TONES[verdict.severity],
      unitLabel: unitLabelEn(material?.displayUnit ?? ""),
    });
  });
}

export async function runProductionPlanningExpirySweep(): Promise<ExpirySweepResult> {
  const evaluatedOn = todayCairo();
  const warnings: string[] = [];
  const data = await loadProductionPlanningDataForSystem();

  const base: ExpirySweepResult = {
    dryRun: data.settings.expiryAlarmDryRun,
    emailSent: false,
    emailSkippedReason: null,
    evaluatedOn,
    lots: 0,
    recorded: 0,
    skipped: null,
    warnings,
  };

  // Switch 1.
  if (!data.settings.expiryAlarmEnabled) return { ...base, skipped: "disabled" };

  // EVERY product, not just the first: the two have separate material lists, and a lot that is
  // about to die does not care which product it belongs to. Deduplicated on the lot's own key,
  // because a material shared between products (citric acid, lemon flavour) appears in both lists.
  const seen = new Set<string>();
  const verdicts: ExpiryVerdict[] = [];
  for (const product of data.products) {
    for (const verdict of evaluateExpiryForProduct(data, product.id, evaluatedOn)) {
      const key = `${verdict.materialId}/${verdict.locationId}/${verdict.expiryDate}`;
      if (seen.has(key)) continue;
      seen.add(key);
      verdicts.push(verdict);
    }
  }
  verdicts.sort((a, b) => a.daysLeft - b.daysLeft || a.code.localeCompare(b.code));

  if (verdicts.length === 0) {
    await stampEvaluated(evaluatedOn, null);
    return { ...base, lots: 0 };
  }

  const dryRun = data.settings.expiryAlarmDryRun;
  const db = getSupabaseAdmin();
  // `product_id` is deliberately left NULL: a lot belongs to a material at a place, and citric acid
  // and lemon flavour are shared between both products — naming one of them on the row would be a
  // choice nobody made. The SEVERITY is not stored either, for a better reason: `days_remaining`
  // beside `warn_days` reconstructs it exactly through `criticalDaysFor`, and a stored band is a
  // second copy of a derivation that can drift from the one the screen shows.
  const rows = verdicts.map((verdict) => ({
    days_remaining: verdict.daysLeft,
    dry_run: dryRun,
    evaluated_on: evaluatedOn,
    expiry_date: verdict.expiryDate,
    held_qty: formatQty(verdict.qty),
    location_id: verdict.locationId,
    material_id: verdict.materialId,
    unit_kind: data.materials.find((candidate) => candidate.id === verdict.materialId)?.unitKind ?? "mass",
    warn_days: data.settings.expiryWarnDays,
  }));

  // One row per lot per Cairo day per mode (the table's own unique constraint), so a second run the
  // same morning updates the figures rather than stacking a second verdict beside them.
  const recordedRes = await db
    .from(PRODPLAN_TABLES.expiryEvents)
    .upsert(rows, { onConflict: "material_id,location_id,expiry_date,evaluated_on,dry_run" })
    .select("id");
  if (recordedRes.error) {
    warnings.push(`Could not record the expiry events: ${recordedRes.error.message}`);
  }
  const recorded = recordedRes.data?.length ?? 0;

  // Switch 2. The rows above are the whole point of a dry run — he reads what would have been sent.
  if (dryRun) {
    await stampEvaluated(evaluatedOn, null);
    return { ...base, dryRun: true, emailSkippedReason: "dry run", lots: verdicts.length, recorded, warnings };
  }

  const rowsForEmail = emailRows(verdicts, data);
  const soonest = verdicts[0]!;
  // Switches 3 and 4 live inside sendTemplatedEmail: an inactive template and a disabled notification
  // environment both come back as `skipped` with a reason, which is reported rather than swallowed.
  const sent = await sendTemplatedEmail({
    context: {
      detailsTable: renderPhoenixDataGrid(EXPIRY_EMAIL_COLUMNS, rowsForEmail),
      detailsTableText: renderPhoenixDataGridText(EXPIRY_EMAIL_COLUMNS, rowsForEmail),
      status: PP_EN.expiryEmailStatus,
      subject: PP_EN.expiryEmailSubject,
      summary: buildExpiryEmailSummary({
        count: formatNumberLatin(verdicts.length),
        productName: data.products.map((product) => nameEnglish(product)).join(" and "),
      }),
    },
    // The Cairo date AND what the sweep found: a repeat run the same morning reaches nobody twice,
    // while a lot that crosses into a worse band tomorrow still gets through.
    idempotencyKey: `prodplan-expiry:${evaluatedOn}:${verdicts.length}:${soonest.daysLeft}`,
    origin: { eventType: "production_expiry_alarm", module: "production_planning" },
    templateKey: "production_planning_expiry",
  });

  if (sent.skipped) {
    await stampEvaluated(evaluatedOn, null);
    return {
      ...base,
      emailSkippedReason: sent.reason ?? "The email was not sent.",
      lots: verdicts.length,
      recorded,
      warnings,
    };
  }

  const markedRes = await db
    .from(PRODPLAN_TABLES.expiryEvents)
    .update({ email_sent: true })
    .eq("evaluated_on", evaluatedOn)
    .eq("dry_run", false);
  if (markedRes.error) {
    // The email HAS gone; reporting that it did not would be the worse error, so this is a warning.
    warnings.push(`The email was sent but could not be marked: ${markedRes.error.message}`);
    logError("Production planner expiry sweep could not mark its rows", {
      labels: { event: "prodplan_expiry_mark_failed", job: "production-planning-reorder" },
      error: markedRes.error,
    });
  }
  await stampEvaluated(evaluatedOn, evaluatedOn);

  return { ...base, emailSent: true, lots: verdicts.length, recorded, warnings };
}

/** When the sweep last looked, and when it last actually sent — two separate facts on purpose. */
async function stampEvaluated(evaluatedOn: string, sentOn: string | null) {
  const patch: Record<string, string> = { expiry_last_evaluated_on: evaluatedOn };
  if (sentOn !== null) patch.expiry_last_sent_on = sentOn;
  const { error } = await getSupabaseAdmin().from(PRODPLAN_TABLES.settings).update(patch).eq("id", 1);
  if (error) {
    logError("Production planner expiry sweep could not stamp the settings row", {
      labels: { event: "prodplan_expiry_stamp_failed", job: "production-planning-reorder" },
      error,
    });
  }
}
