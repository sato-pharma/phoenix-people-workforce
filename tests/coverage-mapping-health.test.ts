import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { collectUnmappedProducts, countBrickDrift } from "../src/lib/sales/import-coverage.ts";

// THE COVERAGE TAB'S TWO MAPPING-HEALTH COLUMNS MUST BE ABLE TO REPORT A PROBLEM.
//
// SoS audit, confirmed. `saveBrickCoverageSnapshot` — the writer on the path EVERY distributor
// upload takes — inserted the literals `brick_drift_count: 0`, `unmapped_products: []` and
// `unmapped_products_count: 0`. The Coverage tab renders those as its "Brick drift" and "Unmapped
// products" columns and builds its drift-alerts panel from `brickDriftCount > 0`, so the module's
// only mapping-health monitor was structurally incapable of ever firing.
//
// Measured on production 2026-09-05: 134 snapshots (2026-06-10 to 2026-09-04, 21 distributors),
// and NOT ONE carries a non-zero drift or unmapped-product value — while 20 of them recorded fewer
// importable rows than total rows, 5,005 rows in all. Unmapped-product rows are auto-excluded at
// commit, so this dashboard is the only place that loss would ever surface, and it always said zero.
//
// The two figures were already in `input.result`; nothing had to be computed, only passed. This
// test pins the DEFINITIONS, because both have a plausible-looking wrong version that would make
// the column noisy instead of silent — and a noisy monitor gets ignored just as fast as a dead one.

const COVERAGE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/import-coverage.ts", import.meta.url)),
  "utf8",
);

const NORMALIZER_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/sales/normalizer/service.ts", import.meta.url)),
  "utf8",
);

export async function runCoverageMappingHealthTests(): Promise<void> {
  // ── 1. drift counts a CHANGED mapping, never a first one ───────────────────────────────────
  // customerBrickCorrections carries both. A customer with no stored brick is a new mapping; if
  // those counted, every first import of a distributor would raise a drift alarm for its whole
  // customer list — the fastest way to make the panel worthless.
  assert.equal(
    countBrickDrift([
      { brickId: "BR-1", previousBrickId: null },
      { brickId: "BR-2", previousBrickId: "" },
    ]),
    0,
    "a customer with no stored brick is a FIRST MAPPING, not drift",
  );
  assert.equal(
    countBrickDrift([{ brickId: "BR-9", previousBrickId: "BR-9" }]),
    0,
    "a correction that resolves to the brick already stored is not drift",
  );
  assert.equal(
    countBrickDrift([
      { brickId: "BR-9", previousBrickId: "BR-4" },
      { brickId: "BR-7", previousBrickId: "BR-3" },
      { brickId: "BR-1", previousBrickId: null },
      { brickId: "BR-2", previousBrickId: "BR-2" },
    ]),
    2,
    "only the customers whose stored brick actually changed are drift",
  );

  // This is the same line buildImportPreviewDiff draws, and it must stay that way: the two
  // functions write the SAME column of the same table.
  const previewSource = readFileSync(
    fileURLToPath(new URL("../src/lib/sales/import-preview.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    previewSource.includes("if (!mapped || mapped === resolved) continue;"),
    "import-preview must still skip unmapped-and-identical customers — if its rule changes, " +
      "countBrickDrift has to change with it or the same column means two different things",
  );

  // ── 2. unmapped products: "product" and "both", never "brick" ───────────────────────────────
  // A "brick" exception is a different failure and is already reported by the coverage figure.
  // Counting it here would report one problem twice and point the reader at the wrong mapping.
  const unmapped = collectUnmappedProducts([
    { rawProduct: "SAGINKO 40MG", reason: "product" },
    { rawProduct: "ROYAFLOX 500", reason: "both" },
    { rawProduct: "SAGINKO 40mg", reason: "product" }, // same label, different case
    { rawProduct: "TETRA 250", reason: "brick" }, // NOT an unmapped product
    { rawProduct: "   ", reason: "product" }, // blank label
    { rawProduct: null, reason: "product" },
  ]);
  assert.deepEqual(
    unmapped.products,
    ["SAGINKO 40MG", "ROYAFLOX 500"],
    "distinct product labels in file order, case-insensitively deduped, blanks dropped, and a " +
      "brick-reason exception excluded",
  );
  assert.equal(unmapped.count, 2, "the count is the distinct total");
  assert.equal(
    collectUnmappedProducts([{ rawProduct: "X", reason: "brick" }]).count,
    0,
    "a brick failure must never be reported as an unmapped product",
  );

  // The count is reported in FULL even when the stored list is sampled — a caller must never
  // report the sample length as the number of unmapped products.
  const many = Array.from({ length: 60 }, (_, i) => ({ rawProduct: `P-${i}`, reason: "product" }));
  assert.equal(collectUnmappedProducts(many).count, 60, "the full distinct count is preserved");

  // ── 3. the writer must not put the literals back ────────────────────────────────────────────
  const writerStart = COVERAGE_SOURCE.indexOf("export async function saveBrickCoverageSnapshot");
  assert.ok(writerStart > 0, "expected saveBrickCoverageSnapshot to still exist");
  const writerBody = COVERAGE_SOURCE.slice(writerStart, COVERAGE_SOURCE.indexOf("\nexport ", writerStart + 1));
  for (const literal of ["brick_drift_count: 0", "unmapped_products: []", "unmapped_products_count: 0"]) {
    assert.ok(
      !writerBody.includes(literal),
      `saveBrickCoverageSnapshot must not hardcode \`${literal}\` — that literal is the defect: ` +
        "134 production snapshots, not one able to report a mapping problem",
    );
  }
  assert.ok(
    writerBody.includes("brick_drift_count: input.brickDriftCount") &&
      writerBody.includes("unmapped_products_count: input.unmappedProductsCount"),
    "the writer must persist what the caller measured",
  );

  // Required, not optional. A default is exactly what the bug looked like — a caller that forgets
  // must fail to compile rather than quietly write another zero.
  const signature = COVERAGE_SOURCE.slice(writerStart, COVERAGE_SOURCE.indexOf("): Promise<void>", writerStart));
  for (const field of ["brickDriftCount", "unmappedProducts", "unmappedProductsCount"]) {
    assert.ok(
      new RegExp(`\\b${field}\\??:`).test(signature),
      `saveBrickCoverageSnapshot must take ${field}`,
    );
    assert.ok(
      !new RegExp(`\\b${field}\\?:`).test(signature),
      `${field} must be REQUIRED, not optional — an optional one lets a caller silently write the zero again`,
    );
  }

  // ── 4. the real upload path actually passes them ───────────────────────────────────────────
  const callStart = NORMALIZER_SOURCE.indexOf("await saveBrickCoverageSnapshot({");
  assert.ok(callStart > 0, "the normalizer must still write a coverage snapshot");
  const callBody = NORMALIZER_SOURCE.slice(callStart, NORMALIZER_SOURCE.indexOf("});", callStart));
  assert.ok(
    callBody.includes("brickDriftCount") && callBody.includes("unmappedProducts"),
    "the path every distributor upload takes must pass the measured figures, not omit them",
  );
  assert.ok(
    NORMALIZER_SOURCE.includes("countBrickDrift(input.result.customerBrickCorrections)") &&
      NORMALIZER_SOURCE.includes("collectUnmappedProducts(input.result.exceptions)"),
    "the figures must come from the batch's own corrections and exceptions",
  );
}
