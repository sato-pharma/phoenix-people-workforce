import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateSourceChannel } from "../src/lib/recruitment/candidate-source-context.ts";

/**
 * Pins three defects on the Candidates pool, all live on production 2026-08-24.
 *
 *   #6  The Source filter lost a candidate. Email 211 + WhatsApp 350 = 561 against a pool of 562.
 *       The options were built from the raw `source` column with `.filter(Boolean)`, so the one row
 *       whose source is NULL produced no option and matched none — while the Source COLUMN showed
 *       it correctly as "Manual", because that goes through candidateSourceChannel.
 *   #10 The Received filter offered All time / Last 30 days / Today / Last 7 days, because it
 *       rendered Object.keys() of an alphabetically-declared label map.
 *   #5  The profile header was `sticky top-0 z-20`, the same offset and stacking level as the app's
 *       own topbar, so it painted over the global search box and the role chip.
 */

/** The pool's option list, exactly as the workspace builds it. */
function sourceOptionsFor(candidates: readonly { source: string | null }[]): string[] {
  return Array.from(new Set(candidates.map((c) => candidateSourceChannel(c.source, null).label))).sort(
    (left, right) => left.localeCompare(right),
  );
}

/** The pool's filter, exactly as the workspace applies it. */
function matchesSource(candidate: { source: string | null }, sourceFilter: string): boolean {
  if (!sourceFilter) return true;
  return candidateSourceChannel(candidate.source, null).label === sourceFilter;
}

export function runRecruitmentPoolFilterTests() {
  // ---------------------------------------------------------------------------
  // #6 — the headline: every candidate must be reachable, including the NULL-source one.
  // ---------------------------------------------------------------------------
  // Production's shape on 2026-08-24, scaled down: whatsapp, email, and exactly one null.
  const pool = [
    { source: "whatsapp" },
    { source: "whatsapp" },
    { source: "email" },
    { source: null },
  ];

  const options = sourceOptionsFor(pool);
  assert.ok(options.includes("Manual"), "a NULL source must still be offered as an option");
  assert.deepEqual(options, ["Email", "Manual", "WhatsApp"], "the options are the badge labels, sorted");

  const reached = options.reduce((total, option) => total + pool.filter((c) => matchesSource(c, option)).length, 0);
  assert.equal(
    reached,
    pool.length,
    "the per-source counts must sum to the whole pool — this is the 561-vs-562 defect",
  );

  // Every candidate is reachable by EXACTLY one option: no gaps, and no double counting either.
  for (const candidate of pool) {
    const matching = options.filter((option) => matchesSource(candidate, option));
    assert.equal(matching.length, 1, `a candidate matched ${matching.length} options, expected exactly 1`);
  }

  // The filter and the badge column must answer with the same words, or the filter offers a term
  // the table never shows. "Whatsapp" (what the old humanizer produced) is not "WhatsApp".
  for (const candidate of pool) {
    const label = candidateSourceChannel(candidate.source, null).label;
    assert.ok(options.includes(label), `the column shows "${label}" but no option offers it`);
  }

  // An empty filter is "Any source" and must never exclude anybody.
  assert.equal(pool.filter((c) => matchesSource(c, "")).length, pool.length);

  // ---------------------------------------------------------------------------
  // Source guards on the workspace itself — this logic lives inside a 3,900-line client component.
  // ---------------------------------------------------------------------------
  const workspace = readFileSync("src/components/recruitment/recruitment-workspace.tsx", "utf8");

  // #6: the raw-column comparison is what dropped the row.
  assert.ok(
    !/\(c\.source \?\? ""\)\.trim\(\) !== sourceFilter/.test(workspace),
    "the pool went back to filtering on the raw source column",
  );
  assert.ok(
    /candidateSourceChannel\(c\.source, c\.sourceContext\)\.label !== sourceFilter/.test(workspace),
    "the pool must filter on the source CHANNEL, the same function the column renders",
  );
  assert.ok(
    !/new Set\(candidates\.map\(\(candidate\) => \(candidate\.source \?\? ""\)\.trim\(\)\)\.filter\(Boolean\)\)/.test(
      workspace,
    ),
    "the option list went back to dropping blank sources",
  );

  // #10: an explicit order, never Object.keys() of the label map.
  assert.ok(
    /const poolDateFilterOrder: readonly PoolDateFilter\[\] = \["all", "today", "week", "month"\]/.test(workspace),
    "the Received filter must declare its order explicitly, widening from now outwards",
  );
  assert.ok(
    !/Object\.keys\(poolDateFilterLabels\)/.test(workspace),
    "the Received filter went back to rendering Object.keys() of its label map",
  );

  // #5: the profile header must not be sticky — it collides with the global topbar, and while it
  // was sticky the floating way-back pill below it could never appear, because its
  // IntersectionObserver watches this very element and a sticky header never stops intersecting.
  assert.ok(
    !/className="sticky top-0 z-20 -mx-4 -mt-4 mb-1 flex items-center justify-between/.test(workspace),
    "the candidate profile header is sticky again and will paint over the global topbar",
  );
  assert.ok(
    /className="-mx-4 -mt-4 mb-1 flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2\.5"/.test(
      workspace,
    ),
    "the candidate profile header lost its expected layout classes",
  );
}
