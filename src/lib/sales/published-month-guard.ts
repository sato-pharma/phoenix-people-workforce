/**
 * NEVER CHANGE A PUBLISHED MONTH — the guard that makes the owner's rule mechanical for bulk
 * repairs of already-imported sales rows.
 *
 * Owner's rule, in his words: "never cange a publkished month" (2026-10-09), restating
 * 2026-09-07: "no donot fix any already published an announced month implement this to be
 * considered in the upcomings". A closing that has been published is FINAL — not "final unless
 * the fix is small", not "final unless the number is provably wrong". A ruling that arrives late
 * is a rule for UPCOMING months.
 *
 * WHY A GUARD AND NOT A NOTE. The rule lived as prose, and the bulk customer-map repair
 * (scripts/reconcile-month-customer-map.ts) relied on a DIFFERENT mechanism to honour it: the
 * repair RPC skips any import file that holds a row in a LOCKED closing. That works only while
 * every published month also carries a lock. Nothing enforces that pairing — a lock is the
 * owner's own switch on monthly_closing_locks, a publication is a row in
 * monthly_closing_publications, and they are set by two different screens at two different times.
 * The day a published month has no lock, the repair rewrites it silently and the pre-image CSV is
 * the only trace.
 *
 * It is worse than one period wide. sos_reconcile_import_rows_from_customer_map is keyed on
 * (distributor, customer) and IGNORES the period: a repair seeded from September's CNS rows also
 * re-points that customer's rows in every other month the locks do not freeze. So the guard
 * cannot just look at the period that was asked for — it has to look at every row the run would
 * actually write.
 *
 * SO THIS GUARD ASKS THE PUBLICATION TABLE ITSELF, and refuses on either half:
 *   1. the period the run targets has a live publication on any line, or
 *   2. any row the run would rewrite sits in a month that has a live publication.
 *
 * Publishing is per (line, period), but a period-wide test is the correct one here and not an
 * over-reach: publishing ONE line freezes the store-split net for EVERY line of that month
 * (closing-publication-drift.ts), and a repair keyed on a customer moves rows across lines
 * regardless of the line asked for.
 *
 * IT FAILS CLOSED. livePublishedPeriods throws when it cannot read the table, rather than
 * returning an empty set the way the portal-facing readers in monthly-closing-publication.ts
 * deliberately do. An unreadable publication table must stop a bulk write, never wave it through.
 *
 * IT IS NOT A LOCK ON THE OWNER. The path he uses is the one he already uses: unpublish the month
 * on the publication screen, then run the repair. That is exactly the order tonight's September
 * repair went in — Anti Infective was unpublished at 19:12 Cairo on 2026-10-09, and only then did
 * the rows move. The guard refuses the OTHER order, which nobody should want.
 *
 * Pinned by tests/published-month-guard.test.ts, inside the required CI validate job.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** His rule, recorded where the guard that enforces it can be read beside it. */
export const PUBLISHED_MONTH_RULE = {
  statedOn: "2026-10-09",
  restates: "2026-09-07",
  words: "never cange a publkished month",
} as const;

export type PublishedMonthRisk = {
  /** The period the run was pointed at, when it is itself published. */
  targetPeriod: string | null;
  /** Published periods that rows of this run would have been written into, with the row counts. */
  rowPeriods: Array<{ period: string; rows: number }>;
};

export type PublishedMonthGuardInput = {
  targetPeriod: string;
  publishedPeriods: Iterable<string>;
  /** invoice_period of every row the run would write. Nulls and blanks are ignored. */
  rowPeriods: Iterable<string | null | undefined>;
};

const trimmed = (value: string | null | undefined) => String(value ?? "").trim();

/**
 * What a run would touch that it must not. Pure — no database, no clock — so the decision can be
 * pinned without a connection.
 */
export function findPublishedMonthsAtRisk(input: PublishedMonthGuardInput): PublishedMonthRisk {
  const published = new Set<string>();
  for (const period of input.publishedPeriods) {
    const key = trimmed(period);
    if (key) published.add(key);
  }

  const target = trimmed(input.targetPeriod);
  const counts = new Map<string, number>();
  for (const period of input.rowPeriods) {
    const key = trimmed(period);
    if (!key || !published.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    targetPeriod: target && published.has(target) ? target : null,
    rowPeriods: [...counts.entries()]
      .map(([period, rows]) => ({ period, rows }))
      .sort((left, right) => left.period.localeCompare(right.period)),
  };
}

/** True when nothing this run would write lands in a published month. */
export function publishedMonthRiskIsClear(risk: PublishedMonthRisk): boolean {
  return risk.targetPeriod === null && risk.rowPeriods.length === 0;
}

/** The refusal, in words that name the month and the way past it. */
export function publishedMonthGuardMessage(risk: PublishedMonthRisk): string {
  const parts: string[] = [
    'NEVER CHANGE A PUBLISHED MONTH (owner, 2026-10-09: "never cange a publkished month").',
  ];
  if (risk.targetPeriod) {
    parts.push(`${risk.targetPeriod} has a live closing publication, so this run is refused.`);
  }
  if (risk.rowPeriods.length > 0) {
    const detail = risk.rowPeriods
      .map((entry) => `${entry.period} (${entry.rows} row${entry.rows === 1 ? "" : "s"})`)
      .join(", ");
    parts.push(
      `Rows this run would rewrite sit in published month(s): ${detail}. The repair is keyed on (distributor, customer) and ignores the period, so it reaches months you did not ask for.`,
    );
  }
  parts.push(
    "Unpublish the month on the Monthly Closing publication screen first — that is the owner's decision, never a session's — and run this again afterwards.",
  );
  return parts.join(" ");
}

/** Throws unless the run is clear of every published month. */
export function assertNoPublishedMonthWritten(input: PublishedMonthGuardInput): void {
  const risk = findPublishedMonthsAtRisk(input);
  if (publishedMonthRiskIsClear(risk)) return;
  throw new Error(publishedMonthGuardMessage(risk));
}

/**
 * Every period with a LIVE publication on any line. Throws on a read failure — a bulk write must
 * not proceed on an unanswered question.
 */
export async function livePublishedPeriods(
  supabase: ReturnType<typeof getSupabaseAdmin> = getSupabaseAdmin(),
): Promise<Set<string>> {
  const periods = new Set<string>();
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await supabase
      .from("monthly_closing_publications")
      .select("period")
      .is("unpublished_at", null)
      .order("period", { ascending: true })
      .range(from, from + size - 1);
    if (error) {
      throw new Error(
        `reading the closing publications to honour the published-month rule: ${error.message}`,
      );
    }
    const chunk = data ?? [];
    for (const row of chunk) {
      const key = trimmed((row as { period?: unknown }).period as string | null | undefined);
      if (key) periods.add(key);
    }
    if (chunk.length < size) break;
  }
  return periods;
}
