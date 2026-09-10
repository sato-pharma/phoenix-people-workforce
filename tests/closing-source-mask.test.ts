import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  canRevealClosingSource,
  maskedClosingClientCodes,
  MASKED_SOURCE_DISTRIBUTORS,
  withoutMaskedSourceRows,
} from "@/lib/sales/closing-source-mask";

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
    ["app/api/sales/monthly-closing/export/route.ts"],
    "ONLY the export route reveals, and only because it computes the split from these rows before "
    + "writing them. Every other caller either runs as `system` (revealed by scope) or renders, and "
    + "a render must never reveal. A new name in this list is a new place El Qema can be seen.",
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
    loader.body.includes("input.revealSource === true")
      && loader.body.includes("withoutMaskedSourceRows(relabelled, access)"),
    "the loader must drop unless revealSource is explicitly true — defaulting the other way turns "
    + "every screen into a leak with nothing failing",
  );

  // 🔴 AND IT MUST DROP ABOVE THE OPTIONS, NOT BELOW THE PAGING. This is the ordering bug the
  // first implementation shipped: `buildFilterOptions` runs on the pre-filter rows, so a removal
  // applied to the paged rows left `QM` sitting in the tab's own DISTRIBUTOR DROPDOWN — measured
  // live on Pedia — and left `filteredRowCount` and every figure in `totals` counting rows the
  // reader cannot see. Both are traces, and neither is visible from the rows.
  const seam = loader.body.indexOf("withoutMaskedSourceRows(relabelled, access)");
  const optionsAt = loader.body.indexOf("buildFilterOptions(");
  const filtersAt = loader.body.indexOf("applyDetailFilters(relabelled");
  assert.ok(seam > 0 && optionsAt > 0, "both the removal and the option builder are still there");
  assert.ok(
    seam < optionsAt,
    "the removal has to run BEFORE buildFilterOptions, or the distributor dropdown names El Qema",
  );
  assert.equal(
    filtersAt,
    -1,
    "and the filters must read the survivors, never `relabelled` — filtering the unmasked rows puts "
    + "the count and the totals out of step with what is on the page",
  );
}
