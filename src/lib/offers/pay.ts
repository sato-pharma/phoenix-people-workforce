/**
 * The offer's compensation formula.
 *
 * Decoded from three signed offers (Dr Samaa Shalaby — DSM Delta 3; Omar Tamer — MR Tanta;
 * Adel Srour — Senior MR Downtown) and verified to the pound against all three. One number is
 * typed by the person making the offer — the total monthly package. Everything else is derived:
 *
 *   cost of living  = a flat monthly amount fixed by JOB TITLE, not by person
 *   remainder       = total − cost of living
 *   basic           = 70% of the remainder, rounded to the pound
 *   transport       = whatever is left of the remainder
 *   annual (each)   = its monthly figure × 12
 *
 * Transport is the REMAINDER, not a second `round(remainder * 0.30)`. Two independent roundings
 * can each land on .5 and produce components that sum to one pound more or less than the total —
 * on a document somebody signs, and against which they are later paid. Taking transport as what
 * is left makes `basic + transport + costOfLiving === total` an identity at every input.
 *
 * ── Why this does NOT import BASIC_SALARY_RATE from src/lib/payroll/policy.ts ──
 * That constant is also 70%, and it is tempting. It answers a different question: payroll splits
 * an EXISTING base salary into its basic and allowance parts. This splits an offer's package
 * AFTER cost of living has been carved out of it. The two agree numerically today and are free to
 * diverge tomorrow — cost of living is a hiring-market lever, the payroll basic rate is a
 * statutory one. Binding them would mean a change to either silently rewrites the other, and one
 * of those files is owner-locked. They stay separate on purpose.
 */

/** Share of the post-cost-of-living remainder that is basic salary. */
export const OFFER_BASIC_SHARE = 0.7;

export type OfferPayInput = {
  /** Flat monthly cost-of-living allowance for the job title being offered. */
  costOfLiving: number;
  /** The single number a recruiter types: the whole monthly package, cost of living included. */
  totalMonthly: number;
  /** Override the basic share for one offer. Defaults to {@link OFFER_BASIC_SHARE}. */
  basicShare?: number;
};

export type OfferPayLine = {
  annual: number;
  monthly: number;
};

export type OfferPay = {
  basic: OfferPayLine;
  costOfLiving: OfferPayLine;
  total: OfferPayLine;
  transport: OfferPayLine;
};

function line(monthly: number): OfferPayLine {
  return { annual: monthly * 12, monthly };
}

/** Coerce anything the form can produce ("", null, "18,550", NaN) into a non-negative number. */
function toAmount(value: unknown): number {
  const raw = typeof value === "string" ? value.replace(/[,\s]/g, "") : value;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * Build the full compensation table from the total package and the title's cost of living.
 *
 * Guarantees, at every input including the degenerate ones:
 *   basic.monthly + transport.monthly + costOfLiving.monthly === total.monthly
 *   every figure is a non-negative integer number of pounds
 *
 * A cost of living larger than the total is treated as consuming the whole package rather than
 * producing a negative basic — a nonsense input must not print a negative salary on an offer.
 */
export function deriveOfferPay(input: OfferPayInput): OfferPay {
  const total = Math.round(toAmount(input.totalMonthly));
  const costOfLiving = Math.min(total, Math.round(toAmount(input.costOfLiving)));

  const share =
    typeof input.basicShare === "number" && input.basicShare >= 0 && input.basicShare <= 1
      ? input.basicShare
      : OFFER_BASIC_SHARE;

  const remainder = total - costOfLiving;
  const basic = Math.round(remainder * share);
  const transport = remainder - basic;

  return {
    basic: line(basic),
    costOfLiving: line(costOfLiving),
    total: line(total),
    transport: line(transport),
  };
}

/** Thousands-separated, no decimals — how every figure is written on the offer. */
export function formatOfferAmount(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    Number.isFinite(value) ? value : 0,
  );
}
