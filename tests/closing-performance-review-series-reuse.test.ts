import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadSeriesMatrices } from "../src/lib/sales/closing-performance-review.ts";
import type { MonthlyClosingMatrix } from "../src/lib/sales/monthly-distributor-import.ts";
import { stripComments } from "./support/comment-strip.ts";

/**
 * PERF-021 (2026-10-04) — the Performance Review reads the selected month ONCE.
 *
 * `loadMergedMonthlyClosingParts` reads the selected month for the headline, and the by-month series
 * used to read the very same (line, month) again for its own bar. `byPeriod` now carries each month the
 * first load actually read — UNMERGED, keyed by its own period — and the series reuses it.
 *
 * What must not change is what each bar shows, so the series rule is pinned here as behaviour:
 *   - a month already read is never loaded again, and is the same matrix (narrowed the same way);
 *   - it is reused only when its own period AND line are the ones the series would ask for;
 *   - every other month is loaded, and a load that falls back to another month still gives NULL
 *     (never a duplicated column under the wrong heading), as does a load that throws;
 *   - never the FOLDED multi-month `combined` — one bar must never carry the sum of several months.
 */

const REVIEW = "src/lib/sales/closing-performance-review.ts";
const PERIOD_LOAD = "src/lib/sales/monthly-closing-period-load.ts";

function matrix(period: string | null, line: string | null, tag: string): MonthlyClosingMatrix {
  return {
    availableLines: [],
    availablePeriods: [],
    columns: [],
    grandTotal: { cells: [], kind: "grandTotal", rowTotal: { salesUnits: 0, salesValue: 0 } },
    line,
    period,
    regions: [],
    tag,
  } as unknown as MonthlyClosingMatrix;
}

function tagOf(value: MonthlyClosingMatrix | null): string | null {
  return value ? String((value as unknown as { tag: string }).tag) : null;
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

export async function runClosingPerformanceReviewSeriesReuseTests() {
  // ── 1. A month already read is reused, never loaded again ──────────────────────────
  {
    const selected = matrix("2026-08", "Pedia", "first-read-august");
    const loaded: string[] = [];
    const series = await loadSeriesMatrices({
      byPeriod: new Map([["2026-08", selected]]),
      line: "Pedia",
      load: async (period) => {
        loaded.push(period);
        return matrix(period, "Pedia", `fresh-${period}`);
      },
      narrow: (value) => value,
      periods: ["2026-06", "2026-07", "2026-08"],
    });

    assert.deepEqual(loaded, ["2026-06", "2026-07"], "the month the headline already read must not be loaded a second time");
    assert.equal(series[2]?.matrix, selected, "the reused bar must be the very matrix the first read produced");
    assert.deepEqual(
      series.map((entry) => [entry.period, tagOf(entry.matrix)]),
      [
        ["2026-06", "fresh-2026-06"],
        ["2026-07", "fresh-2026-07"],
        ["2026-08", "first-read-august"],
      ],
      "every other month is loaded, and the series keeps its period order",
    );
  }

  // ── 2. The reused month is narrowed exactly as a freshly loaded one would be ───────
  {
    const narrowed: string[] = [];
    const series = await loadSeriesMatrices({
      byPeriod: new Map([["2026-08", matrix("2026-08", "CNS", "first-read")]]),
      line: "CNS",
      load: async (period) => matrix(period, "CNS", `fresh-${period}`),
      narrow: (value) => {
        narrowed.push(tagOf(value)!);
        return matrix(value.period, value.line, `narrowed-${tagOf(value)}`);
      },
      periods: ["2026-07", "2026-08"],
    });
    assert.deepEqual(
      narrowed.sort(),
      ["first-read", "fresh-2026-07"],
      "the review filter must run over the reused month too, or a filtered review would chart one unfiltered bar",
    );
    assert.equal(tagOf(series[1]!.matrix), "narrowed-first-read", "the reused bar is the NARROWED matrix");
  }

  // ── 3. Reused only when its own period and line match what the series would ask for ─
  {
    const loaded: string[] = [];
    const series = await loadSeriesMatrices({
      byPeriod: new Map([
        ["2026-07", matrix("2026-07", "Anti Infective", "other-line")],
        ["2026-08", matrix("2026-06", "Pedia", "mis-keyed")],
      ]),
      line: "Pedia",
      load: async (period) => {
        loaded.push(period);
        return matrix(period, "Pedia", `fresh-${period}`);
      },
      narrow: (value) => value,
      periods: ["2026-07", "2026-08"],
    });
    assert.deepEqual(
      loaded,
      ["2026-07", "2026-08"],
      "a read for another line, or one whose own period is not the key, must never stand in for the series' month",
    );
    assert.deepEqual(
      series.map((entry) => tagOf(entry.matrix)),
      ["fresh-2026-07", "fresh-2026-08"],
      "those months come from the series' own load",
    );
  }

  // ── 4. Today's null rule is preserved for loaded months ────────────────────────────
  {
    const series = await loadSeriesMatrices({
      byPeriod: new Map(),
      line: "Pedia",
      load: async (period) => {
        if (period === "2026-07") return matrix("2026-09", "Pedia", "fell-back-to-default-month");
        if (period === "2026-08") throw new Error("read failed");
        return matrix(period, "Pedia", `fresh-${period}`);
      },
      narrow: (value) => value,
      periods: ["2026-06", "2026-07", "2026-08"],
    });
    assert.equal(
      series[1]!.matrix,
      null,
      "a load that falls back to another month must give null — never a duplicated column under the wrong heading",
    );
    assert.equal(series[2]!.matrix, null, "a month that fails to load renders as not uploaded rather than losing the others");
    assert.equal(tagOf(series[0]!.matrix), "fresh-2026-06", "and the healthy month still renders");
  }

  // ── 5. Wiring: the review hands the series the first read, and byPeriod is unmerged ─
  {
    const review = stripComments(readFileSync(REVIEW, "utf8"));
    const body = functionBody(review, "loadClosingPerformanceReview");
    assert.match(
      body,
      /loadSeriesMatrices\(\{[\s\S]*byPeriod:\s*parts\.byPeriod,/,
      "loadClosingPerformanceReview must hand the series the months the headline load already read",
    );
    const directLoads = body.match(/loadMonthlyClosingPartsWithStoreSplit\(/g) ?? [];
    assert.equal(
      directLoads.length,
      1,
      "the review must read a series month in ONE place only — the loader injected into loadSeriesMatrices",
    );
    assert.match(
      body,
      /load:\s*async \(period\) => \(await loadMonthlyClosingPartsWithStoreSplit\(\{ line: seriesLine, period \}\)\)\.combined,/,
      "that one read is the series' injected loader, for the headline's own resolved line",
    );

    const periodLoad = stripComments(readFileSync(PERIOD_LOAD, "utf8"));
    assert.match(
      periodLoad,
      /byPeriod:\s*byOwnPeriod\(usable\.map\(\(entry\) => entry\.parts!\.combined\)\)/,
      "the multi-month byPeriod must be built from each month's own UNMERGED matrix",
    );
    assert.ok(
      !/byPeriod:\s*byOwnPeriod\(\[\s*mergeMonthlyClosingMatrices/.test(periodLoad),
      "byPeriod must never hold a merged matrix",
    );
    assert.match(
      periodLoad,
      /if \(matrix\.period\) map\.set\(matrix\.period, matrix\);/,
      "byPeriod is keyed by each matrix's OWN period, so a fallback read can never sit under the month asked for",
    );
  }
}
