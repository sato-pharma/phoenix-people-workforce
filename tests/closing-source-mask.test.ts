import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  canRevealClosingSource,
  maskClosingSourceRows,
  maskedClosingClientCodes,
  MASKED_SOURCE_DISTRIBUTORS,
} from "@/lib/sales/closing-source-mask";

/**
 * 🔒 EL QEMA LEAVES NO TRACE IN ANY CLOSING DETAIL — owner, 2026-09-09.
 *
 *   "never show in details… never anyone know that these sales are from Al Qimma, but they appear
 *    in their total and achievements but not in the details."
 *
 * Two halves, and the second is the one that decays. The arithmetic half is easy: blank four fields.
 * The half that needs a guard is WHERE the mask is applied, because it has to sit after every
 * computation and before every render, and both mistakes are silent:
 *
 *   · masked too early → the split stops recognising El Qema, and the numbers change with no error
 *   · masked too late, or not at all → the identity reaches a screen and the rule is simply broken
 *
 * So this file pins the exact set of call sites that ask for the truth, and checks that the export
 * route masks on the way into every workbook it builds.
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

  // ── The mask itself ──────────────────────────────────────────────────────────────────────────
  const masked = maskClosingSourceRows(rows, viewer);
  assert.equal(masked[0].distributorCode, "", "the distributor is blank, not renamed");
  assert.equal(masked[0].clientCode, "", "and so is the customer code");
  assert.equal(masked[0].clientName, "", "and the customer name");
  assert.equal(masked[0].clientAddress, "", "and the address, which names the town");
  assert.equal(masked[0].qty, 700, "but the quantity is untouched — this hides who, never how much");

  // 🔴 NEVER A SUBSTITUTE NAME. He offered to relabel these rows as another real distributor and
  // that was declined: it would put false records into the auditor's file and land the discrepancy
  // on the wrong company. Blank is the answer he then chose. A future "friendlier" placeholder that
  // names any real company fails here.
  for (const field of ["distributorCode", "clientCode", "clientName", "clientAddress"] as const) {
    assert.equal(masked[0][field], "", `${field} must be EMPTY, never a stand-in value`);
  }

  assert.equal(masked[1].distributorCode, "IS", "another distributor is left completely alone");
  assert.equal(masked[1].clientName, "ابن سينا", "name and all");

  assert.equal(
    maskClosingSourceRows(rows, superAdmin),
    rows,
    "a viewer who may reveal gets the SAME array back, so the common path allocates nothing",
  );
  const untouched = [rows[1]];
  assert.equal(
    maskClosingSourceRows(untouched, viewer),
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
      before.includes("maskClosingSourceRows("),
      `${builder} is reached without masking the rows first — the workbook would name El Qema`,
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
    loader.body.includes("input.revealSource === true ? paged : maskClosingSourceRows(paged, access)"),
    "the loader must mask unless revealSource is explicitly true — defaulting the other way turns "
    + "every screen into a leak with nothing failing",
  );
}
