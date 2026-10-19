import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  describeDroppedFilterChoices,
  narrowClosingFilterToOptions,
} from "../src/lib/sales/closing-filter-narrowing.ts";
import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// REFRESH KEEPS THE READER'S FILTER.
//
// The Closing Matrix's reload() cleared the region / area / product filter for all three of its
// callers. Two are right to: change the LINE and the areas and products are different things. The
// third is the REFRESH button — same line, same month, same pickers — where clearing cost the
// reader their filter every time they asked for today's numbers, with nothing saying so. A manager
// watching one region through an upload re-selected it on every press.
//
// Keeping it needs one guard, because a refresh exists precisely so the closing CAN change
// underneath the screen: a selection can name an area that has just been merged away. Left in place
// it matches nothing and the grid reads as empty; dropped in silence it is the same defect facing
// the other way. So a kept filter is narrowed to what the new matrix offers and what fell out is
// named, by the NAME the picker showed for it.
// ─────────────────────────────────────────────────────────────────────────────

const WORKSPACE_SOURCE = "src/components/sales/monthly-closing-workspace.tsx";

const OPTIONS = {
  areas: [{ code: "GZ6", label: "Fayoum - Beni Suef" }, { code: "C11", label: "Cairo 11" }],
  products: [{ code: "LA001", label: "Lacto Advanced" }],
  regions: [{ code: "UE", label: "Upper Egypt" }],
};

function filter(overrides: Partial<{ areaCodes: string[]; productCodes: string[]; regionCodes: string[]; search: string }> = {}) {
  return { areaCodes: [], productCodes: [], regionCodes: [], search: "", ...overrides };
}

export async function runClosingRefreshKeepsTheFilterTests() {
  // ── 1. The regression: Refresh asks to keep the filter, the two selects do not ────────────────
  const workspace = stripComments(readFileSync(WORKSPACE_SOURCE, "utf8"));
  assert.ok(
    /reload\(selectedLine, selectedPeriods, \{ fresh: true, keepFilter: true \}\)/.test(workspace),
    `the Refresh button in ${WORKSPACE_SOURCE} must keep the reader's filter — it reloads the same line and the same months, so clearing it is pure loss`,
  );
  assert.ok(
    /onChange=\{\(event\) => void reload\(event\.target\.value, selectedPeriods\)\}/.test(workspace),
    `the LINE select must NOT keep the filter — a different line offers different areas and products, and carrying a selection across would be meaningless`,
  );
  assert.ok(
    /onChange=\{\(periods\) => void reload\(selectedLine, periods\)\}/.test(workspace),
    `the MONTH select must not keep the filter either`,
  );
  assert.ok(
    workspace.includes("setFilter(emptyMonthlyClosingFilter)"),
    `${WORKSPACE_SOURCE} must still clear the filter on the paths that are not a refresh`,
  );

  // ── 2. A filter the new matrix can still honour comes back untouched ──────────────────────────
  const intact = filter({ areaCodes: ["GZ6"], productCodes: ["LA001"], regionCodes: ["UE"], search: "royal" });
  const keptAll = narrowClosingFilterToOptions(intact, OPTIONS);
  assert.deepEqual(keptAll.droppedCodes, [], "nothing vanished, so nothing may be reported");
  assert.deepEqual(keptAll.filter, intact, "a refresh that changed nothing must leave the filter exactly as it was");

  // ── 3. A selection the refreshed matrix no longer offers is dropped AND named ──────────────────
  const stale = filter({ areaCodes: ["GZ6", "UE9"], productCodes: ["LA001", "GONE"], regionCodes: ["UE", "DELTA3"] });
  const narrowed = narrowClosingFilterToOptions(stale, OPTIONS);
  assert.deepEqual(
    narrowed.filter.areaCodes,
    ["GZ6"],
    "an area merged away since the last load must leave the filter, or the grid reads as empty",
  );
  assert.deepEqual(narrowed.filter.productCodes, ["LA001"]);
  assert.deepEqual(narrowed.filter.regionCodes, ["UE"]);
  assert.deepEqual(
    narrowed.droppedCodes,
    ["UE9", "GONE", "DELTA3"],
    "every dropped code is reported, in selection order, so the page can name them",
  );

  // ── 4. The search term is the reader's words and is never narrowed ─────────────────────────────
  const searched = narrowClosingFilterToOptions(filter({ areaCodes: ["UE9"], search: "Dokki" }), OPTIONS);
  assert.equal(
    searched.filter.search,
    "Dokki",
    "a search term matches text, not a code — a term that currently finds nothing is a search result, not a stale selection",
  );

  // ── 5. The notice names names, never codes, and reads as one sentence or several ───────────────
  assert.equal(describeDroppedFilterChoices([]), null, "nothing dropped, nothing said");
  const one = describeDroppedFilterChoices(["Beni Suef"]);
  assert.ok(
    one?.startsWith("Beni Suef is no longer in this closing"),
    `one dropped choice reads in the singular: ${one}`,
  );
  assert.ok(
    one?.includes("Everything else you had selected is still applied"),
    `the notice must say the rest of the filter survived — that is the whole point of the change: ${one}`,
  );
  const several = describeDroppedFilterChoices(["Beni Suef", "Delta (3)", "Lacto Basic"]);
  assert.ok(
    several?.startsWith("Beni Suef, Delta (3) and Lacto Basic are no longer in this closing"),
    `several dropped choices are listed and read in the plural: ${several}`,
  );
  for (const sentence of [one, several]) {
    assert.ok(sentence && !sentence.includes("…") && !sentence.includes("..."), "no ellipsis in on-screen copy");
  }

  // ── 6. The page narrows against the NEW matrix and names what fell out ────────────────────────
  assert.ok(
    /narrowClosingFilterToOptions\(filterBefore, monthlyClosingFilterOptions\(payload\.data\)\)/.test(workspace),
    `${WORKSPACE_SOURCE} must narrow the kept filter against the matrix it just loaded — narrowing against the old one would keep a selection that has gone`,
  );
  assert.ok(
    workspace.includes("labelsBefore") && workspace.includes("describeDroppedFilterChoices"),
    `${WORKSPACE_SOURCE} must name the dropped choices with the labels the pickers were showing — a code on screen is never acceptable (AGENTS.md §4)`,
  );
  assert.ok(
    workspace.includes("setDroppedFilterLabels([])"),
    `${WORKSPACE_SOURCE} must clear that notice at the start of every load, so it never describes an earlier screen`,
  );
}
