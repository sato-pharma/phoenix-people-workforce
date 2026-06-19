import assert from "node:assert/strict";

import { weeklyContractByCode } from "../src/lib/sales/weekly/column-contract.ts";
import { WEEKLY_DISTRIBUTORS } from "../src/lib/sales/weekly/distributors.ts";

// Guards the declarative column contract (the pre-upload verification source) against silent drift.
// The contract MIRRORS the parser.ts adapters — if it goes stale the AI verification "verifies"
// against a false promise, so these invariants must hold for every distributor we ingest.
export function runWeeklyColumnContractTests() {
  // 1. Every registered distributor has a contract.
  for (const distributor of WEEKLY_DISTRIBUTORS) {
    const contract = weeklyContractByCode(distributor.code);
    assert.ok(contract, `Missing column contract for distributor ${distributor.code}`);
    assert.equal(contract!.code, distributor.code, `Contract code mismatch for ${distributor.code}`);
    assert.equal(
      contract!.splitFiles,
      Boolean(distributor.separateSalesStockFiles),
      `splitFiles flag for ${distributor.code} must match the distributor registry`,
    );
    assert.ok(contract!.sheets.length > 0, `${distributor.code} contract has no sheets`);
  }

  // 2. PS (Overseas) is the only split-file distributor and must reference both files.
  const ps = weeklyContractByCode("PS")!;
  assert.equal(ps.splitFiles, true, "PS must be split-file");
  const psFormFields = new Set(ps.sheets.map((sheet) => sheet.formField));
  assert.ok(psFormFields.has("salesFile") && psFormFields.has("stockFile"), "PS must read both salesFile and stockFile");

  // 3. Field + matrix invariants per sheet.
  for (const distributor of WEEKLY_DISTRIBUTORS) {
    const contract = weeklyContractByCode(distributor.code)!;
    const splitFiles = contract.splitFiles;
    for (const sheet of contract.sheets) {
      assert.ok([1, 2].includes(sheet.headerRowNumber), `${distributor.code}/${sheet.role}: header row must be 1 or 2`);
      // Non-split distributors only ever read the single "file" upload.
      if (!splitFiles) {
        assert.equal(sheet.formField, "file", `${distributor.code}/${sheet.role}: non-split distributors must use the "file" field`);
      }
      assert.ok(sheet.fields.length > 0, `${distributor.code}/${sheet.role}: sheet has no pinned fields`);

      const seenColumns = new Set<number>();
      for (const field of sheet.fields) {
        assert.ok(field.field.trim().length > 0, `${distributor.code}/${sheet.role}: empty field key`);
        assert.ok(field.label.trim().length > 0, `${distributor.code}/${sheet.role}/${field.field}: empty label`);
        assert.ok(
          field.expectedHeaderHint.trim().length > 0,
          `${distributor.code}/${sheet.role}/${field.field}: empty expectedHeaderHint`,
        );
        assert.ok(
          Number.isInteger(field.columnIndex) && field.columnIndex >= 1,
          `${distributor.code}/${sheet.role}/${field.field}: columnIndex must be a positive integer`,
        );
        assert.ok(
          ["key", "value", "context"].includes(field.role),
          `${distributor.code}/${sheet.role}/${field.field}: invalid role "${field.role}"`,
        );
        // Two pinned fields must never claim the same column within one sheet.
        assert.ok(
          !seenColumns.has(field.columnIndex),
          `${distributor.code}/${sheet.role}: duplicate columnIndex ${field.columnIndex}`,
        );
        seenColumns.add(field.columnIndex);
      }

      if (sheet.matrix) {
        assert.ok(
          Number.isInteger(sheet.matrix.firstColumn) && sheet.matrix.firstColumn >= 1,
          `${distributor.code}/${sheet.role}: matrix firstColumn must be a positive integer`,
        );
        if (sheet.matrix.lastColumn != null) {
          assert.ok(
            sheet.matrix.lastColumn >= sheet.matrix.firstColumn,
            `${distributor.code}/${sheet.role}: matrix lastColumn must be >= firstColumn`,
          );
        }
        if (sheet.matrix.stopAtHeaderPattern) {
          // Must compile as a regex.
          assert.doesNotThrow(
            () => new RegExp(sheet.matrix!.stopAtHeaderPattern!, "i"),
            `${distributor.code}/${sheet.role}: stopAtHeaderPattern is not a valid regex`,
          );
        }
      }
    }
  }

  // 4. PS sales matrix must keep the "Total Qty" stop boundary so the preview count matches the parser.
  const psSales = ps.sheets.find((sheet) => sheet.role === "sales");
  assert.ok(psSales?.matrix?.stopAtHeaderPattern, "PS sales matrix must declare a stopAtHeaderPattern (Total Qty boundary)");
  assert.match("Total Qty.", new RegExp(psSales!.matrix!.stopAtHeaderPattern!, "i"), "PS stop pattern should match 'Total Qty.'");
}
