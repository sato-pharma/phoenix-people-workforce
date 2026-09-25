import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildDistributorNameIndex,
  closingDetailDistributorName,
  nameClosingDetailDistributors,
  UNNAMED_DISTRIBUTOR_LABEL,
} from "@/lib/sales/closing-details-distributor-names";
import type { ClosingDetailRow, ClosingDetailsResult } from "@/lib/sales/monthly-closing-details";

/**
 * The closing Details panel shows distributor NAMES, never codes — owner rule (AGENTS.md §4:
 * human-readable names, never raw codes or IDs, in UI and chat).
 *
 * It printed `row.distributorCode` under every customer and as every Distributor filter option.
 * The names are joined on in the details route, AFTER `loadMonthlyClosingDetails` has removed El
 * Qema's rows for every viewer who may not see them, and this file pins three things:
 *
 *   · the naming itself — master name, else "Unnamed distributor", never the code
 *   · the El Qema lock — no name on a masked code for a non-revealing viewer, no option for it,
 *     and nothing on a blank code (a Main Stores row stands in for El Qema's money)
 *   · where it is wired — the route names after the load, the panel renders the name
 */
export function runClosingDetailsDistributorNamesTests() {
  const names = buildDistributorNameIndex([
    { code: "IS-S", name: "Ibn Sina-Sato" },
    { code: "ps", name: "overseas" },
    { code: "QM", name: "El Qema" },
    { code: "EG", name: "   " }, // a blank master name falls through to the fallback
  ]);
  const manager = { role: "National Sales Manager" as const, scope: "line" as const };
  const superAdmin = { role: "Super Admin" as const, scope: "company" as const };
  const system = { role: "National Sales Manager" as const, scope: "system" as const };

  // ── The name ────────────────────────────────────────────────────────────────────────────────
  assert.equal(closingDetailDistributorName("IS-S", names, manager), "Ibn Sina-Sato");
  assert.equal(closingDetailDistributorName(" Ps ", names, manager), "overseas", "matched case- and space-insensitively");
  assert.equal(closingDetailDistributorName("ZZ", names, manager), UNNAMED_DISTRIBUTOR_LABEL, "an unknown code never shows the code");
  assert.equal(closingDetailDistributorName("EG", names, manager), UNNAMED_DISTRIBUTOR_LABEL);
  assert.equal(UNNAMED_DISTRIBUTOR_LABEL, "Unnamed distributor");

  // ── The El Qema lock ────────────────────────────────────────────────────────────────────────
  assert.equal(closingDetailDistributorName("QM", names, manager), "", "a masked source gets NO name for a non-revealing viewer");
  assert.equal(closingDetailDistributorName("qm", names, manager), "");
  assert.equal(closingDetailDistributorName("QM", names, superAdmin), "El Qema", "Super Admin keeps the trace, by owner decision");
  assert.equal(closingDetailDistributorName("QM", names, system), "El Qema");
  assert.equal(closingDetailDistributorName("", names, manager), "", "a blank source (Main Stores) is never named");
  assert.equal(closingDetailDistributorName(null, names, superAdmin), "");

  // ── The result: every row named, every option labelled by name with the code as its value ────
  const row = (id: number, distributorCode: string) => ({ id, distributorCode }) as unknown as ClosingDetailRow;
  const result = {
    rows: [row(1, "IS-S"), row(2, "PS"), row(3, ""), row(4, "ZZ"), row(5, "QM")],
    options: { regions: [], areas: [], products: [], distributors: ["IS-S", "PS", "QM", "ZZ"] },
  } as unknown as ClosingDetailsResult;

  const forManager = nameClosingDetailDistributors(result, names, manager);
  assert.deepEqual(forManager.rows.map((r) => r.distributorName), ["Ibn Sina-Sato", "overseas", "", UNNAMED_DISTRIBUTOR_LABEL, ""]);
  assert.deepEqual(
    forManager.options.distributors,
    [
      { code: "IS-S", name: "Ibn Sina-Sato" },
      { code: "PS", name: "overseas" },
      { code: "ZZ", name: UNNAMED_DISTRIBUTOR_LABEL },
    ],
    "El Qema is dropped from the options, never offered blank; the rest sort by name",
  );
  for (const r of forManager.rows) {
    if (r.distributorCode) assert.notEqual(r.distributorName, r.distributorCode, `row ${r.id} must not show its code`);
  }
  // The codes the filter sends back are untouched.
  assert.deepEqual(forManager.rows.map((r) => r.distributorCode), ["IS-S", "PS", "", "ZZ", "QM"]);

  const forSuperAdmin = nameClosingDetailDistributors(result, names, superAdmin);
  assert.ok(forSuperAdmin.options.distributors.some((o) => o.code === "QM" && o.name === "El Qema"));

  // ── The wiring ──────────────────────────────────────────────────────────────────────────────
  const route = readFileSync(resolve("app/api/sales/monthly-closing/details/route.ts"), "utf8");
  assert.match(route, /nameClosingDetailDistributors\(details, distributorNames, access\)/, "the route names the loader's output for this viewer");
  assert.ok(
    route.indexOf("loadMonthlyClosingDetails({") < route.indexOf("nameClosingDetailDistributors(details"),
    "names go on after the load, so after the El Qema mask",
  );

  const panel = readFileSync(resolve("src/components/sales/closing-details-panel.tsx"), "utf8");
  assert.doesNotMatch(panel, /\{row\.distributorCode\}/, "the panel never renders a row's distributor code");
  assert.match(panel, /\{row\.distributorName\}/);
  assert.match(panel, /value=\{distributor\.code\}>\{distributor\.name\}<\/option>/, "filter options: code as value, name as label");
}
