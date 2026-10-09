// Is ONE month's distributor upload set complete yet? The pure half.
//
// WHY THIS EXISTS (owner, 2026-10-09). He parked the September store-split rebuild on a condition
// rather than a date — "rebuild September's split once the last books are in, not now" — so
// something has to notice when the last book lands. A frozen month keeps drifting with every
// upload, so the rebuild is worth exactly one shot, at the end.
//
// 🔴 THE EXPECTATION IS LAST MONTH'S SOURCES, NEVER THE WHOLE HISTORY'S. `buildSosCoverageReport`
// expects every source in every loaded period on purpose (the SoS history was backfilled, so a
// never-uploaded January is indistinguishable from an onboarding) — which is right for the audit
// banner and wrong as a gate: chimipharm last supplied 2026-05, so an all-history rule would call
// every month since then incomplete for ever and the gate would never fire. This module uses the
// same basis `source-coverage.ts` uses for a closing's completeness — what fed the month BEFORE —
// and keeps the coverage engine's two carve-outs on top of it.
//
// 🔴 A SOURCE CARRIED BY ANOTHER'S FILE LAST MONTH IS STILL EXPECTED THIS MONTH. EPDA-BULK is the
// live case: its file was folded into EPDA-Pharmacies' for 2026-07..2026-08 only, so it is absent
// from last month's present set while being exactly the book the September EPDA-BULK contribution
// rule needs. Dropping it from the expectation because last month was quiet would hide the one
// absence that rule depends on.
//
// Deliberately pure: `scripts/check-sos-month-complete.ts` does the I/O and the reporting, and the
// test pins the judgement without touching the database.

import { canonicalDistributorKey, DIRECT_CHANNEL_CODE, DIRECT_CHANNEL_LABEL } from "@/lib/sales/direct-channel";
import type { SosCoverageBatch, SosCoverageReport } from "@/lib/sales/sos-coverage";
import { previousPeriod } from "@/lib/sales/source-coverage";

/** A source that is quiet in this month because another source's file carried it. */
export type MonthCompletenessMerge = {
  /** The quiet source, by name — standing rule: names, never raw codes. */
  name: string;
  /** The source whose file carried it. */
  into: string;
};

/** A source still owed for the month. Both halves travel: the name is shown, the code is matched. */
export type MonthCompletenessMissing = {
  code: string;
  name: string;
};

export type MonthCompleteness = {
  period: string;
  /** The month the expectation is taken from — the calendar month before `period`. */
  comparedTo: string;
  /** True when the period has at least one validated batch — i.e. the upload has begun. */
  started: boolean;
  /** Sources last month had (or had carried for it) and this month does not, by name. */
  missing: MonthCompletenessMissing[];
  /** Absences the coverage engine explains away — listed so a reader sees WHY they are quiet. */
  mergedExplained: MonthCompletenessMerge[];
  /** Started, and nothing missing. The one boolean a caller should branch on. */
  complete: boolean;
};

/** Canonical codes with at least one validated batch in `period`. */
function presentKeys(batches: readonly SosCoverageBatch[], period: string): Set<string> {
  const keys = new Set<string>();
  for (const batch of batches) {
    if (String(batch.period ?? "") !== period) continue;
    const key = canonicalDistributorKey(batch.distributorCode);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Code → what to call it. The LATEST period that carries a name wins, so a source renamed mid-year
 * reads under its current name, and the Direct channel keeps its one label across both vintages.
 */
function namesByKey(batches: readonly SosCoverageBatch[]): Map<string, { code: string; name: string }> {
  const byKey = new Map<string, { code: string; name: string; period: string }>();
  for (const batch of batches) {
    const raw = String(batch.distributorCode ?? "").trim();
    const key = canonicalDistributorKey(raw);
    if (!key) continue;
    const period = String(batch.period ?? "");
    const name = String(batch.distributorName ?? "").trim();
    const held = byKey.get(key);
    if (held && held.period > period) continue;
    byKey.set(key, {
      code: key === DIRECT_CHANNEL_CODE ? DIRECT_CHANNEL_CODE : raw,
      name: key === DIRECT_CHANNEL_CODE ? DIRECT_CHANNEL_LABEL : name || held?.name || raw,
      period,
    });
  }
  const names = new Map<string, { code: string; name: string }>();
  for (const [key, value] of byKey) names.set(key, { code: value.code, name: value.name });
  return names;
}

/**
 * The completeness verdict for one period.
 *
 * A period with NO batches at all is `started: false` and never `complete` — "nothing uploaded yet"
 * and "everything uploaded" produce the same empty missing-list, and only the presence of batches
 * separates them.
 */
export function summarizeMonthCompleteness(input: {
  batches: readonly SosCoverageBatch[];
  period: string;
  /** The coverage engine's report, read ONLY for its merge carve-outs. */
  report: SosCoverageReport;
}): MonthCompleteness {
  const period = String(input.period ?? "").trim();
  const prev = previousPeriod(period) ?? "";
  const present = presentKeys(input.batches, period);
  const presentBefore = presentKeys(input.batches, prev);
  const names = namesByKey(input.batches);

  const mergedIn = (target: string): Map<string, MonthCompletenessMerge> => {
    const merges = new Map<string, MonthCompletenessMerge>();
    for (const source of input.report.mergedSources) {
      if (!source.periods.includes(target)) continue;
      const key = canonicalDistributorKey(source.distributorCode);
      if (key) merges.set(key, { into: source.into, name: source.name });
    }
    return merges;
  };
  const mergedNow = mergedIn(period);
  const mergedBefore = mergedIn(prev);

  // Expected = what fed last month, PLUS whatever another source's file carried for it last month.
  const expected = new Set<string>([...presentBefore, ...mergedBefore.keys()]);
  const missing = [...expected]
    .filter((key) => !present.has(key) && !mergedNow.has(key))
    .map((key) => names.get(key) ?? { code: key, name: key })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    comparedTo: prev,
    complete: present.size > 0 && missing.length === 0,
    mergedExplained: [...mergedNow.values()].sort((left, right) => left.name.localeCompare(right.name)),
    missing,
    period,
    started: present.size > 0,
  };
}

/** One line a non-engineer can act on. Never null — "complete" is the headline worth saying. */
export function describeMonthCompleteness(summary: MonthCompleteness): string {
  const merged = summary.mergedExplained
    .map((entry) => `${entry.name} is carried by ${entry.into}`)
    .join("; ");
  const mergedNote = merged ? ` ${merged} — quiet on purpose, not missing.` : "";
  if (!summary.started) {
    return `${summary.period} has no validated upload at all yet.`;
  }
  if (summary.complete) {
    return `${summary.period} is COMPLETE — every source that fed ${summary.comparedTo} has landed.${mergedNote}`;
  }
  const names = summary.missing.map((entry) => entry.name).join(", ");
  return (
    `${summary.period} is still missing ${summary.missing.length} source${summary.missing.length === 1 ? "" : "s"} that fed ${summary.comparedTo}: ${names}.` +
    mergedNote
  );
}
