import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildManagerChain,
  buildManagersAboveByHrId,
  managerFilterOptions,
  managersAbove,
  matchesManagerFilter,
} from "../src/lib/org/manager-filter.ts";
import { stripComments } from "./support/comment-strip.ts";

// Owner, 2026-10-20: "when you filter by manager you find no manager". A manager filter built from
// the rows' direct managers, matching `row.managerName === selected`, never showed the manager's own
// row, and a National Sales Manager's choice showed his district managers and none of their reps.

export function runManagerFilterTests() {
  const rows = [
    { employeeName: "National One", managerName: "Chief" },
    { employeeName: "District One", managerName: "National One" },
    { employeeName: "District Two", managerName: "National One" },
    { employeeName: "Rep A", managerName: "District One" },
    { employeeName: "Rep B", managerName: "District One" },
    { employeeName: "Rep C", managerName: "District Two" },
    { employeeName: "Other Rep", managerName: "Other District" },
  ];
  const chain = buildManagerChain(rows);

  const pick = (manager: string) =>
    rows.filter((row) => matchesManagerFilter(row, manager, chain)).map((row) => row.employeeName);

  assert.deepEqual(
    pick("District One"),
    ["District One", "Rep A", "Rep B"],
    "choosing a district manager shows HIS OWN row and his reps",
  );
  assert.deepEqual(
    pick("National One"),
    ["National One", "District One", "District Two", "Rep A", "Rep B", "Rep C"],
    "choosing a National Sales Manager shows him, his district managers AND every rep beneath them",
  );
  assert.deepEqual(pick("Chief"), rows.slice(0, 6).map((row) => row.employeeName), "the whole chain under the top");
  assert.deepEqual(pick("Other District"), ["Other Rep"], "a manager with no row of his own still filters his reports");
  assert.equal(
    rows.every((row) => matchesManagerFilter(row, "", chain)),
    true,
    "an empty choice filters nothing out",
  );

  assert.deepEqual(
    managerFilterOptions(rows, chain),
    ["Chief", "District One", "District Two", "National One", "Other District"],
    "every manager on the chain is offered, sorted, each once",
  );
  // A list of reps only still offers the managers above their district managers.
  const repsOnly = rows.filter((row) => row.employeeName.startsWith("Rep"));
  assert.deepEqual(
    managerFilterOptions(repsOnly, chain),
    ["Chief", "District One", "District Two", "National One"],
    "a reps-only list still offers the National Sales Manager when the chain is known",
  );

  // A loop in the data never hangs.
  const loop = buildManagerChain([
    { employeeName: "A", managerName: "B" },
    { employeeName: "B", managerName: "A" },
  ]);
  assert.deepEqual(managersAbove("A", loop), ["B"]);
  assert.equal(matchesManagerFilter({ employeeName: "A", managerName: "B" }, "Z", loop), false);

  // A reps-only list whose rows carry the chain above their district manager (from the directory)
  // still offers — and finds — the Regional and National Sales Managers who have no row of their own.
  const repsWithChain = [
    { employeeName: "Rep A", managerName: "District One", managersAbove: ["Regional One", "National One"] },
    { employeeName: "Rep C", managerName: "District Two", managersAbove: ["National One"] },
  ];
  const fullChain = buildManagerChain(repsWithChain);
  assert.deepEqual(
    managerFilterOptions(repsWithChain, fullChain),
    ["District One", "District Two", "National One", "Regional One"],
    "the managers above the district managers are offered though none of them has a row",
  );
  assert.deepEqual(
    repsWithChain.filter((row) => matchesManagerFilter(row, "National One", fullChain)).map((row) => row.employeeName),
    ["Rep A", "Rep C"],
    "choosing the National Sales Manager keeps every rep beneath him",
  );
  assert.deepEqual(
    repsWithChain.filter((row) => matchesManagerFilter(row, "Regional One", fullChain)).map((row) => row.employeeName),
    ["Rep A"],
  );

  // The HR-id walk the KPIs board uses: managers ABOVE the direct one, nearest first.
  const above = buildManagersAboveByHrId([
    { hrId: "r-1", managerHrId: "D-1", managerName: "District One" },
    { hrId: "D-1", managerHrId: "N-1", managerName: "National One" },
    { hrId: "N-1", managerHrId: "C-1", managerName: "Chief" },
    { hrId: "C-1", managerHrId: null, managerName: null },
    { hrId: "X-1", managerHrId: "X-2", managerName: "Loop Two" },
    { hrId: "X-2", managerHrId: "X-1", managerName: "Loop One" },
  ]);
  assert.deepEqual(above.get("R-1"), ["National One", "Chief"], "the direct manager is not repeated; the chain above him is");
  assert.deepEqual(above.get("D-1"), ["Chief"]);
  assert.deepEqual(above.get("C-1"), [], "the top of the tree has nobody above");
  assert.deepEqual(above.get("X-1"), [], "a loop stops instead of hanging");

  const kpisBoard = stripComments(readFileSync(new URL("../src/lib/crm/kpis-board.ts", import.meta.url), "utf8"));
  assert.match(
    kpisBoard,
    /managersAbove: managersAboveByHrId\.get\(canonicalHrIdKey\(employee\.hrId\) \?\? ""\) \?\? \[\]/,
    "the KPIs board stamps every rep's chain from the directory, so 'Reports to' can find a National Sales Manager",
  );

  // The Field Workforce Compliance workspace uses it for every manager filter on every tab.
  const workspace = stripComments(
    readFileSync(
      new URL("../src/components/field-workforce-compliance/field-workforce-compliance-workspace.tsx", import.meta.url),
      "utf8",
    ),
  );
  assert.match(
    workspace,
    /if \(key === "managerName"\) return matchesManagerFilter\(item, selected, managerChainFor\(items\)\);/,
    "Field Workforce Compliance matches the Manager filter through the reporting chain",
  );
  assert.match(
    workspace,
    /if \(key === "managerName"\) return managerFilterOptions\(items, managerChainFor\(items\)\);/,
    "Field Workforce Compliance offers every manager on the chain",
  );
  assert.equal(
    /matchesHierarchyFilters\([a-zA-Z]+, hierarchyFilters\)/.test(workspace),
    false,
    "no caller matches the hierarchy filters without the rows the chain is built from",
  );
}
