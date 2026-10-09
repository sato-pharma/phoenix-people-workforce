// A held mapping change's detail — the SHAPE only: the types, and the pure shaping the screen and
// the loader both use.
//
// WHY THIS IS ITS OWN FILE, AND MUST STAY ONE. The review screen is a `"use client"` component, and
// the loader next door (`mapping-guard-detail.ts`) reaches the Supabase admin client and the
// normalizer's suggestion pipeline, which reach `node:crypto` by way of the employee directory.
// Webpack refuses a Node builtin in a client bundle (UnhandledSchemeError) and the dev server then
// 500s EVERY request — so the component may not import the loader at all, not even for a formatter.
// TYPES are erased at compile time; `describeMonth` and `formatEgp` are not.
//
// Nothing here may import anything that is not itself client-safe.
// `tests/client-bundle-server-leak.test.ts` is what catches a regression, in the required
// `validate` job.

export const CUSTOMER_MAP_TABLE = "source_of_sales_customer_map";

export type HoldSalesImpactRow = { holdId: number; period: string; trackedValue: number; rowCount: number };

export type HoldSalesImpact = {
  /** Tracked value filed under this customer, all months together. */
  trackedValue: number;
  /** Every month it has sales in, newest first. */
  months: Array<{ period: string; trackedValue: number }>;
  /**
   * The months a release would RE-CREDIT: everything before the month we are in.
   *
   * This is the district manager's complaint of 2026-10-09 in one number. A move applies to the
   * crosswalk, and every already-imported row for that customer is re-pointed with it, so a closed
   * month's credit changes under a manager who has already downloaded it.
   */
  restatedMonths: Array<{ period: string; trackedValue: number }>;
  restatedValue: number;
  rowCount: number;
};

/** What the distributor's own file carried for this customer, exactly as filed. */
export type HoldDistributorFact = {
  period: string;
  filedName: string | null;
  filedAddress: string | null;
  filedBrickId: string | null;
  filedBrickName: string | null;
  filedArea: string | null;
  filedRegion: string | null;
  rowsFiled: number;
  lastFiled: string | null;
};

export type SuggestionVerdict = "agrees-with-change" | "agrees-with-mapping" | "third-answer" | "none";

export type HoldSuggestion = {
  brickId: string;
  label: string;
  /** "propagated" (a twin), "address", "place" or "ai" — the normalizer's own free steps. */
  source: string;
  confidence: number | null;
  verdict: SuggestionVerdict;
};

export type HoldDetail = {
  holdId: number;
  /** Only a customer mapping has a source and a confidence to stamp, so only it can be locked. */
  lockable: boolean;
  /** The address Phoenix holds for the pharmacy, which is not necessarily the one filed. */
  storedAddress: string | null;
  storedName: string | null;
  distributorName: string | null;
  sales: HoldSalesImpact | null;
  filed: HoldDistributorFact[];
  suggestion: HoldSuggestion | null;
  /** Other rows still pending for the SAME customer — the repeat he could not see. */
  siblingPending: number;
};

/** `YYYY-MM` for the month we are in, in Cairo. A past month is anything before it. */
export function currentCairoPeriod(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    month: "2-digit",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}`;
}

export function summarizeHoldSales(
  rows: readonly HoldSalesImpactRow[],
  currentPeriod: string,
): Map<number, HoldSalesImpact> {
  const byHold = new Map<number, HoldSalesImpact>();
  for (const row of rows) {
    const current = byHold.get(row.holdId) ?? {
      months: [],
      restatedMonths: [],
      restatedValue: 0,
      rowCount: 0,
      trackedValue: 0,
    };
    const month = { period: row.period, trackedValue: row.trackedValue };
    current.months.push(month);
    current.trackedValue += row.trackedValue;
    current.rowCount += row.rowCount;
    // A string comparison is exact for `YYYY-MM` and needs no date parsing, which is the whole
    // reason the period is stored that way.
    if (row.period < currentPeriod) {
      current.restatedMonths.push(month);
      current.restatedValue += row.trackedValue;
    }
    byHold.set(row.holdId, current);
  }
  for (const impact of byHold.values()) {
    impact.months.sort((a, b) => b.period.localeCompare(a.period));
    impact.restatedMonths.sort((a, b) => b.period.localeCompare(a.period));
  }
  return byHold;
}

/**
 * Does the normalizer's answer back the change, back the mapping as it stands, or name a third
 * brick?
 *
 * "A third answer" is the most useful of the three and the easiest to lose: it means neither side of
 * the hold is where the pharmacy belongs, so Allow and Keep as is are both wrong and the row needs a
 * ruling rather than a click.
 */
export function verdictForSuggestion(
  suggestedBrickId: string,
  mappingBrickId: string,
  changeBrickId: string,
): SuggestionVerdict {
  const key = (value: string) => value.trim().toUpperCase();
  const suggested = key(suggestedBrickId);
  if (!suggested) return "none";
  if (suggested === key(changeBrickId)) return "agrees-with-change";
  if (suggested === key(mappingBrickId)) return "agrees-with-mapping";
  return "third-answer";
}

/** Allow releases the held change; Keep as is leaves the mapping where it stands. */
export type NormalizerDecision = "approved" | "rejected";

/**
 * The click the normalizer own answer implies for one hold, or `null` when it implies none.
 *
 * `agrees-with-change` is an Allow and `agrees-with-mapping` is a Keep as is, because those are the
 * only two bricks a hold stands between. 🔴 A `third-answer` NAMES A BRICK NEITHER BUTTON WRITES, so
 * it is never answered here: clicking either one would file the pharmacy where the normalizer has
 * just said it does not belong. That row, and one the normalizer could not read at all, is left
 * waiting and reported.
 */
export function decisionForSuggestion(
  suggestion: HoldSuggestion | null | undefined,
): NormalizerDecision | null {
  if (!suggestion) return null;
  if (suggestion.verdict === "agrees-with-change") return "approved";
  if (suggestion.verdict === "agrees-with-mapping") return "rejected";
  return null;
}

/**
 * What one press of AI suggest would do to a whole screen of holds.
 *
 * Built in the order the screen lists them, so the counts the button PRINTS are the counts it then
 * applies. The two it cannot answer are returned rather than dropped: 184 pending holds read on
 * production on 2026-10-10 split 113 keep, 8 allow, 3 third answer and 60 with no suggestion, so a
 * third of the screen is left waiting and he has to be told which third.
 */
export type NormalizerAnswerPlan = {
  approve: number[];
  reject: number[];
  thirdAnswer: number[];
  unanswered: number[];
};

export function planNormalizerAnswers(
  holdIds: readonly number[],
  suggestionOf: (holdId: number) => HoldSuggestion | null | undefined,
): NormalizerAnswerPlan {
  const plan: NormalizerAnswerPlan = { approve: [], reject: [], thirdAnswer: [], unanswered: [] };
  for (const holdId of holdIds) {
    const suggestion = suggestionOf(holdId) ?? null;
    const decision = decisionForSuggestion(suggestion);
    if (decision === "approved") plan.approve.push(holdId);
    else if (decision === "rejected") plan.reject.push(holdId);
    else if (suggestion?.verdict === "third-answer") plan.thirdAnswer.push(holdId);
    else plan.unanswered.push(holdId);
  }
  return plan;
}

/** Cut a plan into pages no single request may exceed — the route refuses more than 60. */
export function pageHoldIds(holdIds: readonly number[], size: number): number[][] {
  const step = Math.max(1, Math.floor(size));
  const pages: number[][] = [];
  for (let index = 0; index < holdIds.length; index += step) pages.push(holdIds.slice(index, index + step));
  return pages;
}

/**
 * The filed variants worth showing, newest month first.
 *
 * Deduped on the TEXT, not on the month: a distributor that filed the same address for nine months
 * running is one fact, and printing it nine times buries the one month that differs. Two different
 * addresses under one code stay as two rows, because that is the case that makes a hold come back
 * for ever whatever he clicks — EPDA-Pharmacies code 22199672 is two unrelated pharmacies in two
 * governorates.
 */
export function pickDistributorFacts(
  facts: readonly HoldDistributorFact[],
  limit = 4,
): HoldDistributorFact[] {
  const seen = new Map<string, HoldDistributorFact>();
  const ordered = [...facts].sort((a, b) => b.period.localeCompare(a.period));
  for (const fact of ordered) {
    const key = [fact.filedName, fact.filedAddress, fact.filedBrickId, fact.filedArea, fact.filedRegion]
      .map((part) => (part ?? "").trim().toLowerCase())
      .join(" | ");
    const existing = seen.get(key);
    if (existing) {
      existing.rowsFiled += fact.rowsFiled;
      continue;
    }
    seen.set(key, { ...fact });
  }
  return [...seen.values()].slice(0, Math.max(1, limit));
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * `2026-09` → `September 2026`.
 *
 * Spelled out from a table that ships with this code, never from the reader's ICU build: a client
 * component asking for a short month name renders "Sep" on one browser and "Sept" on another, and
 * React throws the server HTML away over that one character (hydration #418). And never shortened
 * with an ellipsis — the standing rule is that text wraps, it is not cut.
 */
export function describeMonth(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : period;
}

/** `34029.316` → `34,029.32 EGP`. Two decimals always, so two rows line up. */
export function formatEgp(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `${safe.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} EGP`;
}
