/**
 * Production Planner — the reorder verdict.
 *
 * The owner's instruction, 2026-10-05: "انا علشان اجيب الماده الخام اللي تغطيني في الكوارتر بحتاج
 * اطلبها قبلها بست شهور... انت هتبتدي لما يبقى فاضل الكميه اللي تكفيني مثلا ران واحده بس انك تبعت
 * لي" — the imported material takes six months to arrive, so start emailing him when what is left
 * covers only about one more run. And the reason the email exists at all, in his words: "ما انا كده
 * هنسى" — otherwise he will forget.
 *
 * ── What this file deliberately does NOT decide ──────────────────────────────────────────────────
 *
 * It decides whether a material is BELOW its threshold. It does not decide whether to send an email:
 * that is the cron's job and it is gated four separate ways (`alarm_enabled`, `alarm_dry_run`, the
 * template's `is_active`, and `EMAIL_NOTIFICATIONS_ENABLED`). Keeping the verdict pure is what lets
 * the dry run write exactly the rows a real run would, so he can read what WOULD have been sent.
 *
 * It also raises nothing for a material the FACTORY brings, or one nobody has settled with the
 * factory yet. Emailing him to reorder EGPI's own citric acid would be noise, and noise is how a
 * real alarm gets ignored — the same burial arithmetic that keeps the refused-readings board silent.
 */
import { formatExactRuns } from "./geometry";
import type { MaterialRequirement } from "./requirements";
import { QTY_SCALE } from "./rules";

/** How urgent, so the email can lead with the one that cannot wait. */
export type AlarmSeverity = "out_of_stock" | "below_threshold" | "approaching";

export type AlarmVerdict = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly severity: AlarmSeverity;
  /** Cover in micro-runs, so "0.9 of a run" survives the trip to the email. */
  readonly coverRunsMicro: bigint;
  readonly thresholdRunsMicro: bigint;
  readonly heldQty: bigint;
  readonly neededPerRunQty: bigint;
  readonly leadTimeDays: number | null;
  readonly isImported: boolean;
};

export type AlarmInput = {
  /** The threshold from settings, in micro-runs. 1 run is `1_000_000n`. */
  readonly defaultThresholdRunsMicro: bigint;
  /** Per-material override, in micro-runs, when one is set on the material row. */
  readonly thresholdByMaterialId: ReadonlyMap<string, bigint>;
};

/**
 * Anything at or below its threshold, worst first.
 *
 * "Approaching" is the band between the threshold and twice it. It exists because an imported
 * material with six months of lead time is already late by the time it reaches one run of cover, and
 * a warning he can act on beats an alarm he cannot.
 */
export function evaluateAlarms(
  requirements: readonly MaterialRequirement[],
  input: AlarmInput,
): AlarmVerdict[] {
  const verdicts: AlarmVerdict[] = [];

  for (const row of requirements) {
    // Only what we buy and deliver ourselves, and only what has a formula to divide by.
    if (!row.contributesToBuyList) continue;
    if (row.coverRunsMicro === null || row.neededPerRunQty <= BigInt(0)) continue;

    const threshold = input.thresholdByMaterialId.get(row.materialId) ?? input.defaultThresholdRunsMicro;
    if (threshold <= BigInt(0)) continue;

    const cover = row.coverRunsMicro;
    let severity: AlarmSeverity | null = null;
    if (row.heldTotalQty <= BigInt(0)) {
      severity = "out_of_stock";
    } else if (cover <= threshold) {
      severity = "below_threshold";
    } else if (row.isImported && cover <= threshold * BigInt(2)) {
      // Only for an imported material: for a local one, twice the threshold is simply enough.
      severity = "approaching";
    }
    if (severity === null) continue;

    verdicts.push({
      materialId: row.materialId,
      code: row.code,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      severity,
      coverRunsMicro: cover,
      thresholdRunsMicro: threshold,
      heldQty: row.heldTotalQty,
      neededPerRunQty: row.neededPerRunQty,
      leadTimeDays: row.leadTimeDays,
      isImported: row.isImported,
    });
  }

  const rank: Record<AlarmSeverity, number> = { out_of_stock: 0, below_threshold: 1, approaching: 2 };
  return verdicts.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      (a.coverRunsMicro < b.coverRunsMicro ? -1 : a.coverRunsMicro > b.coverRunsMicro ? 1 : 0) ||
      a.code.localeCompare(b.code),
  );
}

/** A threshold typed in runs, into micro-runs. `1.5` runs is `1_500_000n`. */
export function thresholdRunsToMicro(runs: bigint): bigint {
  return runs * QTY_SCALE;
}

/** Cover as the email and the screen print it: `900000n` → `"0.9"`. */
export function formatCoverRuns(coverRunsMicro: bigint): string {
  return formatExactRuns(coverRunsMicro);
}

/**
 * Whether the sweep should even run, read FAIL-SAFE off the settings row.
 *
 * `enabled` requires an explicit `true` and `dryRun` requires an explicit `false`, so a missing row,
 * a null column or a read that half-failed all land on "switched off, and sending nothing".
 */
export function resolveAlarmArming(row: {
  readonly alarm_enabled?: unknown;
  readonly alarm_dry_run?: unknown;
} | null): { enabled: boolean; dryRun: boolean } {
  return {
    enabled: row?.alarm_enabled === true,
    dryRun: row?.alarm_dry_run !== false,
  };
}

/** The same fail-safe reading for the daily FX fetch, which has its own independent pair. */
export function resolveFxArming(row: {
  readonly fx_fetch_enabled?: unknown;
  readonly fx_fetch_dry_run?: unknown;
} | null): { enabled: boolean; dryRun: boolean } {
  return {
    enabled: row?.fx_fetch_enabled === true,
    dryRun: row?.fx_fetch_dry_run !== false,
  };
}
