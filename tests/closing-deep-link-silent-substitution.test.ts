import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeClosingDeepLinkMiss,
  resolveClosingDeepLinkMiss,
} from "../src/lib/sales/closing-deep-link.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// A DEEP LINK THE CLOSING COULD NOT HONOUR MUST BE NAMED ON THE PAGE.
//
// /sales/monthly-closing?line=&period= is how the published-closing email opens the matrix, and how
// any bookmarked or pasted link does. loadMonthlyClosingParts validates each parameter against the
// lines and months it actually has, and on a miss falls back to availableLines[0] /
// availablePeriods[0] — the newest month of the first line.
//
// The fallback is right. Its SILENCE was the defect: the page then rendered a complete, ordinary
// closing for a different line or month than the link asked for, with nothing on screen saying a
// substitution had happened, so a manager clicking "Pedia, August" in last month's email could read
// September's national total believing it was August's.
//
// The client-side picker never did this quietly — a requested month it could not read is named in
// an amber line above the matrix. This suite holds the same promise for the first, server-rendered
// read, and checks the two places it has to be wired to work at all.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE_SOURCE = "app/(admin)/sales/monthly-closing/page.tsx";
const WORKSPACE_SOURCE = "src/components/sales/monthly-closing-workspace.tsx";
const LOADER_SOURCE = "src/lib/sales/monthly-distributor-import.ts";

export async function runClosingDeepLinkSilentSubstitutionTests() {
  // ── 1. The regression: both halves substituted, and the reader is told ────────────────────────
  const miss = resolveClosingDeepLinkMiss({
    requestedLine: "Pedia",
    requestedPeriod: "2026-08",
    resolvedLine: "Anti Infective",
    resolvedPeriod: "2026-09",
  });
  assert.deepEqual(
    miss,
    { line: "Pedia", period: "2026-08" },
    "a link for Pedia August that landed on Anti Infective September is a substitution, and the page must know it happened",
  );
  const sentence = describeClosingDeepLinkMiss(miss!, { line: "Anti Infective", period: "2026-09" });
  for (const fragment of ["Pedia", "August 2026", "Anti Infective", "September 2026"]) {
    assert.ok(
      sentence.includes(fragment),
      `the notice must name what was asked for AND what is on screen — "${fragment}" is missing from: ${sentence}`,
    );
  }
  assert.ok(!sentence.includes("…") && !sentence.includes("..."), "no ellipsis in on-screen copy");

  // ── 2. An honoured link says nothing at all ───────────────────────────────────────────────────
  assert.equal(
    resolveClosingDeepLinkMiss({
      requestedLine: "CNS",
      requestedPeriod: "2026-09",
      resolvedLine: "CNS",
      resolvedPeriod: "2026-09",
    }),
    null,
    "a link that opened exactly what it asked for must raise no notice",
  );
  assert.equal(
    resolveClosingDeepLinkMiss({ resolvedLine: "CNS", resolvedPeriod: "2026-09" }),
    null,
    "a normal visit carries no line or period, so there is nothing to substitute",
  );

  // ── 3. Case and surrounding space are NOT a substitution ──────────────────────────────────────
  // The loader's own membership test is exact, so "cns" misses and lands on the first line — but
  // when the first line IS that line the reader got what they asked for, and a notice would be a
  // false alarm.
  assert.equal(
    resolveClosingDeepLinkMiss({
      requestedLine: " cns ",
      requestedPeriod: " 2026-09 ",
      resolvedLine: "CNS",
      resolvedPeriod: "2026-09",
    }),
    null,
    "a casing or whitespace difference is the same line and the same month — no notice",
  );
  assert.deepEqual(
    resolveClosingDeepLinkMiss({ requestedLine: "cns", resolvedLine: "Anti Infective" }),
    { line: "cns", period: null },
    "but a lower-case line that landed on a DIFFERENT line is still a substitution, and the notice quotes the link's own spelling",
  );

  // ── 4. Nothing loaded is not a substitution ───────────────────────────────────────────────────
  assert.equal(
    resolveClosingDeepLinkMiss({ requestedLine: "Pedia", requestedPeriod: "2026-08" }),
    null,
    "with no closing loaded at all the page already says there is no validated data — a substitution notice would describe one that never happened",
  );
  assert.equal(
    resolveClosingDeepLinkMiss({ requestedPeriod: "2026-08", resolvedLine: "CNS", resolvedPeriod: "" }),
    null,
    "a month that resolved to nothing is the empty-state, not a substitution",
  );

  // ── 5. One half at a time ─────────────────────────────────────────────────────────────────────
  const periodOnly = resolveClosingDeepLinkMiss({
    requestedPeriod: "2026-08",
    resolvedLine: "Pedia",
    resolvedPeriod: "2026-09",
  });
  assert.deepEqual(periodOnly, { line: null, period: "2026-08" });
  const periodSentence = describeClosingDeepLinkMiss(periodOnly!, { line: "Pedia", period: "2026-09" });
  assert.ok(
    periodSentence.includes("August 2026") && periodSentence.includes("September 2026"),
    `the month notice must name both months: ${periodSentence}`,
  );
  assert.ok(
    !periodSentence.includes("Pedia"),
    `the line was honoured, so the month notice must not imply it was not: ${periodSentence}`,
  );

  const lineOnly = resolveClosingDeepLinkMiss({
    requestedLine: "Head Office",
    resolvedLine: "CNS",
    resolvedPeriod: "2026-09",
  });
  assert.deepEqual(lineOnly, { line: "Head Office", period: null });
  const lineSentence = describeClosingDeepLinkMiss(lineOnly!, { line: "CNS", period: "2026-09" });
  assert.ok(
    lineSentence.includes("Head Office") && lineSentence.includes("CNS"),
    `the line notice must name both lines: ${lineSentence}`,
  );

  // ── 6. An unparseable month is handed back untouched, never guessed at ────────────────────────
  const junk = resolveClosingDeepLinkMiss({
    requestedPeriod: "2026-13",
    resolvedLine: "CNS",
    resolvedPeriod: "2026-09",
  });
  assert.deepEqual(junk, { line: null, period: "2026-13" });
  assert.ok(
    describeClosingDeepLinkMiss(junk!, { line: "CNS", period: "2026-09" }).includes("2026-13"),
    "a month the app cannot name is quoted as it arrived, so the reader can see the link was malformed",
  );

  // ── 7. It is actually wired — a notice nothing renders is not a notice ────────────────────────
  const page = stripComments(readFileSync(PAGE_SOURCE, "utf8"));
  assert.ok(
    page.includes("resolveClosingDeepLinkMiss"),
    `${PAGE_SOURCE} must compare the ?line=/?period= it was given against the closing it actually loaded`,
  );
  assert.ok(
    page.includes("initialDeepLinkMiss"),
    `${PAGE_SOURCE} must hand the substitution to the workspace — computing it and dropping it is the same silence`,
  );
  const workspace = stripComments(readFileSync(WORKSPACE_SOURCE, "utf8"));
  assert.ok(
    workspace.includes("describeClosingDeepLinkMiss"),
    `${WORKSPACE_SOURCE} must render the substitution notice above the matrix`,
  );
  assert.ok(
    workspace.includes("setDeepLinkMiss(null)"),
    `${WORKSPACE_SOURCE} must clear the notice once the reader loads a line or month themselves — it would otherwise describe a screen they have left`,
  );

  // ── 8. The loader still substitutes, which is why the notice exists ───────────────────────────
  const loader = stripComments(readFileSync(LOADER_SOURCE, "utf8"));
  assert.ok(
    loader.includes("availableLines.includes(input.line)") && loader.includes("availablePeriods.includes(input.period)"),
    `${LOADER_SOURCE} no longer validates ?line=/?period= by membership — re-read its fallback, because this notice describes what that fallback does`,
  );
  assert.ok(
    loader.includes("availableLines[0] ?? null") && loader.includes("availablePeriods[0] ?? null"),
    `${LOADER_SOURCE} no longer falls back to the first line and newest month. If it now REFUSES an unknown line or month instead, this suite and the notice it pins should go with it.`,
  );
}
