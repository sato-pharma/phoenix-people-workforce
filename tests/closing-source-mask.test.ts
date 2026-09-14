import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  canRevealClosingSource,
  maskedClosingClientCodes,
  MASKED_SOURCE_DISTRIBUTORS,
  withoutMaskedSourceRows,
} from "@/lib/sales/closing-source-mask";
import { MAIN_STORES_LABEL, wholeUnitShares } from "@/lib/sales/closing-main-stores";

/**
 * 🔒 EL QEMA LEAVES NO TRACE IN ANY CLOSING DETAIL — owner, 2026-09-09.
 *
 *   "never show in details… never anyone know that these sales are from Al Qimma, but they appear
 *    in their total and achievements but not in the details."
 *
 * 🔒 AND SINCE 2026-09-10 THE ROW ITSELF LEAVES. Owner, asked and answered: "hide all
 * customers related to el qema from the details sheet make them never reachable and hide them from
 * everywhere never anyone can reach except system admin", then "yes remove them completely from
 * details". Blanking four columns was the first implementation and it left the money on the page
 * with nobody's name on it, which three surfaces then described out loud. See the module.
 *
 * Two halves, and the second is the one that decays. The arithmetic half is easy: drop the rows.
 * The half that needs a guard is WHERE the removal is applied, because it has to sit after every
 * computation and before every render, and both mistakes are silent:
 *
 *   · dropped too early → the split stops recognising El Qema, and the numbers change with no error
 *   · dropped too late, or not at all → the identity reaches a screen and the rule is simply broken
 *
 * So this file pins the exact set of call sites that ask for the truth, and checks that the export
 * route drops on the way into every workbook it builds.
 */
export function runClosingSourceMaskTests() {
  const viewer = { role: "National Sales Manager" as const, scope: "line" as const };
  const superAdmin = { role: "Super Admin" as const, scope: "company" as const };
  const system = { role: "Super Admin" as const, scope: "system" as const };

  assert.deepEqual([...MASKED_SOURCE_DISTRIBUTORS], ["QM"], "El Qema alone, owner 2026-09-09");

  // ── Who may see the truth ────────────────────────────────────────────────────────────────────
  assert.equal(canRevealClosingSource(superAdmin), true, "Super Admin sees the real source");
  assert.equal(canRevealClosingSource(system), true, "and so does every computation path");
  assert.equal(canRevealClosingSource(viewer), false, "nobody else does — not even an NSM");

  const rows = [
    { distributorCode: "QM", clientCode: "3743", clientName: "الفرسان بنها جملة", clientAddress: "بنها", qty: 700 },
    { distributorCode: "IS", clientCode: "9001", clientName: "ابن سينا", clientAddress: "القاهرة", qty: 120 },
  ];

  // ── The removal itself ───────────────────────────────────────────────────────────────────────
  const shown = withoutMaskedSourceRows(rows, viewer);
  assert.equal(shown.length, 1, "El Qema's row is GONE, not blanked — owner, 2026-09-10");
  assert.equal(shown[0]!.distributorCode, "IS", "and the row that survives is somebody else's");
  assert.equal(shown[0]!.clientName, "ابن سينا", "name and all — another distributor is left alone");

  // 🔴 NOTHING IS LEFT STANDING IN ITS PLACE. He offered to relabel these rows as another real
  // distributor and that was declined: it would put false records into the auditor's file and land
  // the discrepancy on the wrong company. He then chose blank columns, and on 2026-09-10 chose to
  // remove the row outright. A future "friendlier" version that keeps a placeholder row — blank,
  // dashed, "other", or a real company's name — fails here.
  for (const row of shown) {
    assert.notEqual(
      String(row.distributorCode ?? "").trim().toUpperCase(),
      "QM",
      "no El Qema row survives under any label",
    );
    assert.ok(
      String(row.distributorCode ?? "").trim() !== "",
      "and no row is left behind with an empty distributor, which is what a placeholder looks like",
    );
  }

  assert.equal(
    withoutMaskedSourceRows(rows, superAdmin),
    rows,
    "a viewer who may reveal gets the SAME array back, so the common path allocates nothing",
  );
  const untouched = [rows[1]];
  assert.equal(
    withoutMaskedSourceRows(untouched, viewer),
    untouched,
    "and the same array back when the page holds no El Qema row at all",
  );

  // ── Main Stores: whole units that still add back ─────────────────────────────────────────────
  //
  // Owner, 2026-09-10: "make the fraction to the nearest full unit … 234.59 is 235", on a sheet
  // whose total has to keep matching the closing.
  //
  // 🔴 ROUNDING EACH AREA ON ITS OWN IS THE BUG THIS GUARDS. Thirty-eight areas each rounding
  // a half unit upward manufactures about nineteen units nobody sold. Largest remainder is the only
  // rounding whose parts add back, and the property — not the arithmetic — is what is asserted.
  assert.equal(MAIN_STORES_LABEL, "Main Stores", "his own words for it, 2026-09-10");

  const shares = [
    { row: "D11", units: 234.590610755986 },
    { row: "D14", units: 229.99 },
    { row: "D15", units: 229.99 },
    { row: "AB1", units: 225.48 },
  ];
  const exact = wholeUnitShares(shares);
  assert.equal(
    exact.reduce((sum, share) => sum + share.units, 0),
    Math.round(shares.reduce((sum, share) => sum + share.units, 0)),
    "the whole units add back to the fractional total — that is the invariant, not the rounding",
  );
  assert.ok(exact.every((share) => Number.isInteger(share.units)), "and every one of them is whole");
  assert.equal(
    exact.find((share) => share.row === "D11")?.units,
    235,
    "234.59 reads as 235 — his own example",
  );
  for (const share of exact) {
    const before = shares.find((one) => one.row === share.row)!.units;
    assert.ok(
      Math.abs(share.units - before) < 1,
      `${share.row} moved ${Math.abs(share.units - before)} of a unit — no area may move a whole one`,
    );
  }

  // A pathological case the naive rounder gets wrong: three thirds of one unit. Rounding each on
  // its own gives 0+0+0 and loses the unit; largest remainder gives 1+0+0 and keeps it.
  const thirds = wholeUnitShares([
    { row: "a", units: 1 / 3 },
    { row: "b", units: 1 / 3 },
    { row: "c", units: 1 / 3 },
  ]);
  assert.equal(
    thirds.reduce((sum, share) => sum + share.units, 0),
    1,
    "a unit split three ways is still one unit — naive rounding loses it entirely",
  );

  // ── The client-code set the Store Split sheets are masked by ─────────────────────────────────
  const codes = maskedClosingClientCodes(rows, viewer);
  assert.deepEqual([...codes], ["3743"], "only El Qema's customers");
  assert.equal(
    maskedClosingClientCodes(rows, superAdmin).size,
    0,
    "and nothing at all when the viewer may reveal",
  );

  // ── 🔴 WHERE THE MASK SITS. The half that decays. ────────────────────────────────────────────
  const ROOT = resolve(import.meta.dirname, "..");
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (/\.tsx?$/.test(full)) out.push(full);
    }
    return out;
  };
  const sources = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "app")), ...walk(join(ROOT, "scripts"))]
    .map((file) => ({ file: file.slice(ROOT.length + 1).replace(/\\/g, "/"), body: readFileSync(file, "utf8") }));

  // Every file that asks for the real source, by name. Adding one has to be a deliberate act, so
  // this list is the review: a new name here means somebody decided a surface may see El Qema.
  const revealers = sources
    .filter((entry) => entry.body.includes("revealSource: true"))
    .map((entry) => entry.file)
    .sort();
  assert.deepEqual(
    revealers,
    ["app/api/sales/monthly-closing/export/route.ts", "src/lib/sales/monthly-closing-consolidated-export.ts"],
    "ONLY the export route and the consolidated export beside it reveal, and only because each "
    + "computes the split from these rows before writing them. Every other caller either runs as "
    + "`system` (revealed by scope) or renders, and a render must never reveal. A new name in this "
    + "list is a new place El Qema can be seen.",
  );

  // The consolidated export (several months of one line, Super Admin and CEO only — owner,
  // 2026-09-14) re-runs the export route's per-month pipeline, so it reveals for the same reason and
  // must drop the rows on the same way out.
  const consolidatedExport = sources.find(
    (entry) => entry.file === "src/lib/sales/monthly-closing-consolidated-export.ts",
  );
  assert.ok(consolidatedExport, "the consolidated export module is still where it was");
  const consolidatedBuild = consolidatedExport.body.indexOf("buildMonthlyClosingWorkbook(");
  assert.ok(consolidatedBuild > 0, "buildMonthlyClosingWorkbook( is still called from the consolidated export");
  assert.ok(
    consolidatedExport.body.slice(0, consolidatedBuild).includes("withoutMaskedSourceRows("),
    "the consolidated workbook is built without dropping the rows first — it would name El Qema",
  );
  assert.ok(
    consolidatedExport.body.includes("storeSplitMaskedClients:"),
    "the consolidated export passes the masked client codes, or its Store Split sheets name El Qema's "
    + "customers even though its Data sheet does not",
  );

  // The export route reveals, so it MUST mask again on the way into every workbook. Both builders
  // are checked by name rather than by counting calls, because a third builder added later would
  // pass a count check while leaking.
  const exportRoute = sources.find((entry) => entry.file === "app/api/sales/monthly-closing/export/route.ts");
  assert.ok(exportRoute, "the export route is still where it was");
  for (const builder of ["buildMonthlyClosingWorkbook(", "buildClosingDetailsWorkbook("]) {
    const at = exportRoute.body.indexOf(builder);
    assert.ok(at > 0, `${builder} is still called from the export route`);
    const before = exportRoute.body.slice(0, at);
    assert.ok(
      before.includes("withoutMaskedSourceRows("),
      `${builder} is reached without dropping the rows first — the workbook would name El Qema`,
    );
  }
  assert.ok(
    exportRoute.body.includes("storeSplitMaskedClients:"),
    "the export route passes the masked client codes, or the Store Split sheets name El Qema's "
    + "customers even though the Data sheet does not",
  );

  // The loader masks by DEFAULT. A future edit that flips the default to reveal would leave every
  // display surface leaking and every test above still green, so the default is asserted here.
  const loader = sources.find((entry) => entry.file === "src/lib/sales/monthly-closing-details.ts");
  assert.ok(loader, "the closing detail loader is still where it was");
  assert.ok(
    loader.body.includes("input.revealSource !== true && !canRevealClosingSource(access)"),
    "the loader must substitute unless the caller asked for the real rows OR the viewer may reveal "
    + "— testing only the flag hands a Super Admin El Qema's rows AND a full set of Main Stores "
    + "rows on top of them, which is the month counted twice with nothing to show it",
  );

  // 🔴 THE ORDER IS THE WHOLE RULE, AND TWO SEPARATE BUGS LIVE IN IT.
  //
  // The removal must run ABOVE `buildFilterOptions`: that builder reads the PRE-FILTER rows, so a
  // removal applied further down — against the paged rows, where it first shipped — left `QM` in
  // the tab's own DISTRIBUTOR DROPDOWN with nothing in the rows to show for it. Measured on Pedia.
  //
  // The Main Stores substitution must run ABOVE `applyDetailScope`, because a share is a fraction
  // of a NATIONAL pool. Built after the scope, a regional manager's four areas would divide El
  // Qema's warehouses among themselves and each take about nine times what the closing credits — a
  // number that is wrong, large, and looks entirely plausible on the page.
  const removalAt = loader.body.indexOf("withoutMaskedSourceRows(credited, access)");
  const buildAt = loader.body.indexOf("buildMainStoresRows(merged, {");
  const creditAt = loader.body.indexOf("applyCreditedAreaView(merged, {");
  const scopeAt = loader.body.indexOf("applyDetailScope(");
  const optionsAt = loader.body.indexOf("buildFilterOptions(");
  assert.ok(removalAt > 0, "the loader still removes the masked rows");
  assert.ok(buildAt > 0, "and still builds Main Stores from the whole month, never a scoped slice");
  assert.ok(creditAt > 0, "and still builds the credited view from the whole month too");
  assert.ok(scopeAt > 0 && optionsAt > 0, "the scope gate and the option builder are still there");
  assert.ok(buildAt < scopeAt, "Main Stores is built BEFORE the access scope narrows the month");
  assert.ok(creditAt < scopeAt, "and so is the credited view, for the same reason");
  assert.ok(removalAt < optionsAt, "and the removal runs before the distributor dropdown is built");

  // 🔴 BOTH PASSES READ `merged`, AND THE REMOVAL READS THEIR OUTPUT — never the reverse.
  //
  // The city split is a POOL: which areas share a wholesaler's sell-in depends on who else is in
  // that city. Handing either pass a population El Qema had already been removed from asks the
  // split a different question from the one the Closing Matrix asked, and the answer then differs
  // by an amount nothing on the page can explain. Every area ties today; that is what would break.
  assert.ok(
    creditAt < removalAt,
    "the credited view runs over the whole month and the masked rows are dropped from its RESULT — "
    + "removing them first changes the city pool and every area stops tying to its closing",
  );
  assert.equal(
    loader.body.indexOf("applyCreditedAreaView(withoutMaskedSourceRows"),
    -1,
    "and the two are never nested the other way round",
  );
}
