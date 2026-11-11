// THE OWNER'S OFFICE EXCEPTIONS — one named month at a time, beside the golden rule, never inside it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS
//
// The Office channel carries no geography, so the owner's LOCKED golden rule spreads it across the
// line's areas by each area's share of the line's non-Office sales VALUE (office-allocation.ts, the
// `GOLDEN RULE · LOCKED` region, unchanged by this file). An entry below is the owner's own decision
// to move a fixed amount of that month's Office VALUE from some areas to others AFTER the rule has
// spread it. The rule still runs first and still decides every other month; an entry only shifts the
// shares it produced, for its one line and its one period.
//
// It is applied in the read-time respread (closing-office-respread.ts), the one step every closing
// read goes through — the matrix, its downloads, and the attribution nets the rep figures read — so
// the closing, the exports and each rep's sales credit agree.
//
// ─────────────────────────────────────────────────────────────────────────────
// CNS · OCTOBER 2026 (owner, 2026-11-11, Cairo)
//
// His words: "reps exceeding the 120% take from their office sales and distribute on all other reps",
// "take from the top achievers office sales and give the low performance", then, shown that the line
// stood at 75.1% so no redistribution could lift everyone to 80%, "exception this month follow what i
// am saying", and he approved this exact table: the five highest reps capped at 123 / 121 / 119 / 117
// / 115%, and the 323,188.24 EGP freed lifting the twelve lowest to 47.6% each.
//
// Measured on the live CNS October 2026 closing on 2026-11-11, after every October book had landed
// (Ibn Sina Tender at 13:22, Office at 13:24 Cairo), before publication:
//
//   Assuit 2       139.8% → 123.0%     Helwan-Maadi   134.0% → 117.0%
//   Sohag1         138.2% → 121.0%     Alex East      129.7% → 115.0%
//   Heliopolis     137.9% → 119.0%
//   Cairo East 1, Dokki - Mohandseen - Bolak, October - Zayed, Sharkia 1, Sharkia 2, Dakahlia 2,
//   Dakahlia 3, Haram - Faisal, Assuit 1, Giza - Giza Centers, Qalubeya, Minia 1 → 47.6%
//
// The amounts are FIXED EGP, not percentages: a book corrected before publication moves an area's
// achievement a little, and the moved amount stays exactly what he approved. They sum to zero, so the
// line total, every product total and the grand total are unchanged.
//
// 🔴 A NEW ENTRY IS THE OWNER'S WORD FOR ONE NAMED MONTH, NEVER A SESSION'S INFERENCE, and it is added
// before that month is published (a published month never moves). The upload-time drift check
// (scripts/check-office-allocation-drift.ts) compares the stored spread with the bare rule, so it
// reports a month listed here as drifted by the moved amount — that is this entry, not a fault.

export type OfficeOwnerException = {
  line: string;
  period: string;
  /** Who decided and when — for the reader of this file. */
  decided: string;
  /** Area code → Office VALUE in EGP to add (positive) or take (negative). Must sum to zero. */
  moves: Readonly<Record<string, number>>;
};

export const OFFICE_OWNER_EXCEPTIONS: readonly OfficeOwnerException[] = [
  {
    line: "CNS",
    period: "2026-10",
    decided: "owner, 2026-11-11 — top five capped 123/121/119/117/115%, twelve lowest lifted to 47.6%",
    moves: {
      // Taken — the five highest achievers.
      UE4: -56_594.83, // Assuit 2
      UE5: -57_928.04, // Sohag1
      CA1: -64_002.66, // Heliopolis
      GZ5: -75_710.07, // Helwan-Maadi
      AB1: -68_952.64, // Alex East
      // Given — the twelve lowest.
      CA3: 12_207.45, // Cairo East 1
      GZ2: 15_200.36, // Dokki - Mohandseen - Bolak
      GZ7: 16_900.12, // October - Zayed
      D25: 18_714.36, // Sharkia 2
      D23: 20_296.6, // Dakahlia 3
      GZ4: 20_324.07, // Haram - Faisal
      UE3: 22_781.65, // Assuit 1
      GZ1: 28_177.28, // Giza - Giza Centers
      D22: 33_924.48, // Dakahlia 2
      D24: 36_677.49, // Sharkia 1
      D11: 45_008.62, // Qalubeya
      UE1: 52_975.76, // Minia 1
    },
  },
];

function fold(value: string | null | undefined): string {
  return String(value ?? "").trim().toUpperCase();
}

/** The owner's exception for this line and period, or null. */
export function officeOwnerExceptionFor(
  line: string | null | undefined,
  period: string | null | undefined,
): OfficeOwnerException | null {
  const lineKey = fold(line);
  const periodKey = String(period ?? "").trim();
  if (!lineKey || !periodKey) return null;
  return OFFICE_OWNER_EXCEPTIONS.find((entry) => fold(entry.line) === lineKey && entry.period === periodKey) ?? null;
}

/**
 * The golden rule's area shares with the owner's exception applied.
 *
 * `officeValue` is the month's whole Office VALUE — a share of it is EGP, so moving `egp` is moving
 * `egp / officeValue` of share. Shares still sum to one, because the moves sum to zero.
 *
 * Returns the shares UNCHANGED (and says why) when the exception cannot be applied as approved: no
 * Office value, a taking area the rule gave no share, or a take larger than the area's whole Office
 * credit. Half an exception is not what he approved, so it is all or nothing.
 */
export function applyOfficeOwnerException(
  areaShare: ReadonlyMap<string, number>,
  exception: OfficeOwnerException | null,
  officeValue: number,
): { areaShare: Map<string, number>; applied: boolean; reason: string | null } {
  const unchanged = (reason: string | null) => ({ areaShare: new Map(areaShare), applied: false, reason });
  if (!exception) return unchanged(null);
  if (!(Number.isFinite(officeValue) && officeValue > 0)) return unchanged("the month has no Office value");

  const total = Object.values(exception.moves).reduce((sum, egp) => sum + egp, 0);
  if (Math.abs(total) > 0.005) return unchanged(`the moves sum to ${total.toFixed(2)} EGP, not zero`);

  const next = new Map(areaShare);
  for (const [rawCode, egp] of Object.entries(exception.moves)) {
    const areaCode = fold(rawCode);
    const current = next.get(areaCode) ?? 0;
    const updated = current + egp / officeValue;
    if (egp < 0 && !(current > 0)) return unchanged(`${areaCode} has no Office share to take from`);
    if (updated < -1e-12) return unchanged(`${areaCode} would take more than its whole Office credit`);
    next.set(areaCode, Math.max(0, updated));
  }
  return { areaShare: next, applied: true, reason: null };
}
