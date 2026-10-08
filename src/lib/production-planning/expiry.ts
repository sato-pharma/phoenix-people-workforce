/**
 * Production Planner — the expiry verdict.
 *
 * The owner's instruction, 2026-10-08, three times over: "خانة الاكسبايري ديت مهمة جدا جدا جدا يا
 * عمر" — the expiry column matters enormously — and then the reason: "مش اي اكسبيري ديت which is
 * very important لان انا عندي حاجات هتنتهي 4 27 فانا لازم انتبه لها". Not just any expiry date: he
 * has material that dies in April 2027 and he has to be watching for it. He asked to be warned three
 * months ahead, which is `prodplan_settings.expiry_warn_days` and defaults to 90.
 *
 * ── Why this is a second alarm and not a column on the first ─────────────────────────────────────
 *
 * The reorder alarm answers "order more of this". This one answers "use THIS lot before the other
 * one". They are independent and they disagree constantly: the factory holds 254 kg of Guaifenesin
 * against a 24 kg need, so the reorder alarm will never raise it — and one of those lots still
 * expires. A material can be plentiful and dying at the same time, which is exactly the case a single
 * summed stock figure cannot express. That is why `prodplan_stock_entries` is keyed per LOT.
 *
 * ── What this file deliberately does NOT decide ──────────────────────────────────────────────────
 *
 * Whether to email. The cron decides that, gated the same four independent ways as the reorder sweep
 * (`expiry_alarm_enabled`, `expiry_alarm_dry_run`, the template's `is_active`, and
 * `EMAIL_NOTIFICATIONS_ENABLED`) — so a dry run writes exactly the rows a real run would and he can
 * read what WOULD have been sent before arming anything.
 *
 * It also raises nothing for packaging. Aluminium film, cartons and stickers carry no expiry at all
 * (his words, 2026-10-08: "package material no expiry date \\Aluminum ,boxes & stickers"), so those
 * lots arrive with `expiryDate: null` and are skipped rather than treated as expiring today.
 */

/** How urgent, so the email and the banner can lead with the lot that cannot wait. */
export type ExpirySeverity = "expired" | "critical" | "warning";

export type ExpiryLot = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly locationId: string;
  /** `null` for packaging, which never expires — skipped, never read as "expires today". */
  readonly expiryDate: string | null;
  readonly qty: bigint;
};

export type ExpiryVerdict = {
  readonly materialId: string;
  readonly code: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly locationId: string;
  readonly expiryDate: string;
  readonly qty: bigint;
  /** Negative once the date has passed. Zero means it dies today. */
  readonly daysLeft: number;
  readonly severity: ExpirySeverity;
};

export type ExpiryInput = {
  /** Cairo today, `YYYY-MM-DD` — a stock position is dated where the factory is. */
  readonly today: string;
  /** How far ahead to look, from settings. The owner asked for three months. */
  readonly warnDays: number;
};

/**
 * Whole days from `from` to `to`, both `YYYY-MM-DD`.
 *
 * 🔴 Parsed as UTC midnight deliberately. `new Date("2027-04-27")` is already UTC midnight, but
 * `new Date(2027, 3, 27)` is LOCAL midnight — and mixing the two makes the difference 23 or 25 hours
 * across a DST boundary, which `Math.round` would hide and `Math.floor` would turn into an off-by-one
 * day. Both ends go through `Date.UTC`, so the difference is an exact multiple of 86,400,000.
 */
export function daysBetweenDates(from: string, to: string): number | null {
  const start = parseIsoDateUtc(from);
  const end = parseIsoDateUtc(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / 86_400_000);
}

function parseIsoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const stamp = Date.UTC(year, month - 1, day);
  // Rejects 31 February rather than letting JS roll it forward to 3 March — the same roll-forward
  // that turned a "three months before 31 July" subtraction into 1 May while building his data sheet.
  const back = new Date(stamp);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return stamp;
}

/**
 * The critical band inside the warning window — a third of it, so 90 days gives 30.
 *
 * Derived rather than fixed because `warnDays` is his to change: a hard-coded 30 would swallow the
 * whole window if he ever shortened it to 20 days, and every lot would arrive already critical.
 */
export function criticalDaysFor(warnDays: number): number {
  return Math.max(1, Math.floor(warnDays / 3));
}

/**
 * Every lot already expired or inside the warning window, worst first.
 *
 * A lot holding nothing is skipped: a zero-quantity row that expires is not news, it is a row that
 * was already used up. A lot with no expiry date is packaging and is skipped too.
 */
export function evaluateExpiry(lots: readonly ExpiryLot[], input: ExpiryInput): ExpiryVerdict[] {
  const warnDays = Number.isFinite(input.warnDays) ? Math.trunc(input.warnDays) : 0;
  if (warnDays <= 0) return [];
  const criticalDays = criticalDaysFor(warnDays);

  const verdicts: ExpiryVerdict[] = [];
  for (const lot of lots) {
    if (lot.expiryDate === null) continue;
    if (lot.qty <= BigInt(0)) continue;
    const daysLeft = daysBetweenDates(input.today, lot.expiryDate);
    if (daysLeft === null) continue;
    if (daysLeft > warnDays) continue;

    const severity: ExpirySeverity = daysLeft <= 0 ? "expired" : daysLeft <= criticalDays ? "critical" : "warning";
    verdicts.push({
      code: lot.code,
      daysLeft,
      expiryDate: lot.expiryDate,
      locationId: lot.locationId,
      materialId: lot.materialId,
      nameAr: lot.nameAr,
      nameEn: lot.nameEn,
      qty: lot.qty,
      severity,
    });
  }

  // Soonest first, so the lot that dies next is the lot he reads first. Code breaks the tie, never
  // the quantity: two lots dying the same day are equally urgent whatever their size.
  return verdicts.sort((a, b) => a.daysLeft - b.daysLeft || a.code.localeCompare(b.code));
}

/**
 * Whether the expiry sweep should run, read FAIL-SAFE off the settings row.
 *
 * Exactly the shape of `resolveAlarmArming`: `enabled` needs an explicit `true` and `dryRun` needs
 * an explicit `false`, so a missing row, a null column, or a read that half-failed all land on
 * "switched off, and sending nothing".
 */
export function resolveExpiryArming(row: {
  readonly expiry_alarm_enabled?: unknown;
  readonly expiry_alarm_dry_run?: unknown;
} | null): { enabled: boolean; dryRun: boolean } {
  return {
    dryRun: row?.expiry_alarm_dry_run !== false,
    enabled: row?.expiry_alarm_enabled === true,
  };
}
