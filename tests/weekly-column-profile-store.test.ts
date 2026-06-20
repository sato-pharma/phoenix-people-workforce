import assert from "node:assert/strict";

import {
  listCodeWeeklyContracts,
  weeklyContractByCode,
  type WeeklyDistributorContract,
} from "../src/lib/sales/weekly/column-contract.ts";
import {
  dbRowToContract,
  mergeWeeklyContractsByCode,
  type WeeklyColumnProfileRow,
} from "../src/lib/sales/weekly/weekly-column-profile-store.ts";
import {
  validateWeeklyColumnProfileInput,
  type WeeklyColumnProfileInput,
} from "../src/lib/sales/weekly/weekly-column-profile-admin.ts";

const clone = <T>(value: T): T => structuredClone(value);

function eg(): WeeklyDistributorContract {
  const contract = weeklyContractByCode("EG");
  assert.ok(contract, "EG code contract exists");
  return clone(contract!);
}

function inputFromContract(contract: WeeklyDistributorContract): WeeklyColumnProfileInput {
  return {
    distributorCode: contract.code,
    distributorName: contract.name,
    splitFiles: contract.splitFiles,
    sheets: clone(contract.sheets),
  };
}

// ── mergeWeeklyContractsByCode: DB wins whole-row, others preserved ────────────────────────────
function mergePrecedence() {
  const code = listCodeWeeklyContracts();
  const dbEg: WeeklyDistributorContract = { ...eg(), name: "EGD (edited)" };
  const merged = mergeWeeklyContractsByCode(code, [dbEg]);
  assert.equal(merged.length, code.length, "merge keeps the same distributor count (EG replaced, not added)");
  const mergedEg = merged.find((c) => c.code === "EG");
  assert.equal(mergedEg?.name, "EGD (edited)", "DB EG wholly overrides the code EG");
  const mergedRm = merged.find((c) => c.code === "RM");
  assert.equal(mergedRm?.name, "RAMCO", "untouched distributors keep their code contract");

  // DB-only contract for an existing code still replaces; a brand-new code would be appended.
  const merged2 = mergeWeeklyContractsByCode(code, []);
  assert.equal(merged2.length, code.length, "empty DB overlay == code contracts (count)");
}

// ── dbRowToContract: defensive jsonb → typed contract ──────────────────────────────────────────
function dbRowParsing() {
  const contract = eg();
  const row: WeeklyColumnProfileRow = {
    distributor_code: "EG",
    distributor_name: "EGD",
    split_files: false,
    sheets: clone(contract.sheets) as unknown,
    active: true,
  };
  const parsed = dbRowToContract(row);
  assert.ok(parsed, "row with valid sheets parses");
  assert.equal(parsed?.code, "EG");
  assert.equal(parsed?.sheets.length, contract.sheets.length, "all sheets reconstructed");
  assert.equal(parsed?.sheets[0].fields.length, contract.sheets[0].fields.length, "fields reconstructed");

  // Empty sheets → null (so the resolver falls back to the code contract).
  assert.equal(dbRowToContract({ distributor_code: "EG", sheets: [] }), null, "empty sheets → null (fall back to code)");
  // A sheet missing a valid role is dropped; a row with only bad sheets → null.
  assert.equal(dbRowToContract({ distributor_code: "EG", sheets: [{ headerRowNumber: 1, formField: "file", fields: [] }] }), null, "sheet with no role is dropped");
  // Blank distributor code → null.
  assert.equal(dbRowToContract({ distributor_code: "  ", sheets: clone(contract.sheets) as unknown }), null, "blank code → null");
}

// ── validateWeeklyColumnProfileInput: locked safety boundary ────────────────────────────────────
function validationAllowsIndexEdit() {
  const input = inputFromContract(eg());
  // Move EG sales "salesQty" from col 13 to col 15 — a legitimate column move.
  const salesSheet = input.sheets.find((s) => s.role === "sales")!;
  const qtyField = salesSheet.fields.find((f) => f.field === "salesQty")!;
  qtyField.columnIndex = 15;
  const res = validateWeeklyColumnProfileInput(input);
  assert.equal(res.ok, true, `moving a column index is allowed: ${res.errors.join("; ")}`);

  // Header row 1↔2 is allowed.
  const input2 = inputFromContract(eg());
  input2.sheets[0].headerRowNumber = 2;
  assert.equal(validateWeeklyColumnProfileInput(input2).ok, true, "header row 2 allowed");
}

function validationRejectsUnsafeEdits() {
  const reject = (mutate: (input: WeeklyColumnProfileInput) => void, why: string) => {
    const input = inputFromContract(eg());
    mutate(input);
    const res = validateWeeklyColumnProfileInput(input);
    assert.equal(res.ok, false, `must reject: ${why}`);
  };

  reject((i) => { i.distributorCode = "ZZ"; }, "unknown distributor");
  reject((i) => { i.sheets[0].fields = i.sheets[0].fields.filter((f) => f.field !== "salesQty"); }, "removed field");
  reject((i) => { i.sheets[0].fields.push({ field: "extra", label: "Extra", columnIndex: 40, expectedHeaderHint: "", role: "context" }); }, "added field");
  reject((i) => { const f = i.sheets[0].fields.find((x) => x.field === "salesQty")!; f.role = "context"; }, "changed field role/semantic");
  reject((i) => { i.sheets[0].role = "stock"; }, "changed sheet role");
  reject((i) => { i.sheets[0].formField = "stockFile"; }, "changed file slot");
  reject((i) => { i.sheets.pop(); }, "removed a sheet");
  reject((i) => { const f = i.sheets[0].fields.find((x) => x.field === "salesQty")!; f.columnIndex = 5; }, "duplicate column index (5 = itemCode)");
  reject((i) => { const f = i.sheets[0].fields.find((x) => x.field === "salesQty")!; f.columnIndex = 0; }, "column index < 1");
  reject((i) => { i.sheets[0].headerRowNumber = 3; }, "header row out of {1,2}");

  // PS matrix edit must be rejected.
  const ps = weeklyContractByCode("PS");
  assert.ok(ps);
  const psInput = inputFromContract(clone(ps!));
  const salesMatrixSheet = psInput.sheets.find((s) => s.matrix)!;
  salesMatrixSheet.matrix!.firstColumn = 6; // was 5
  assert.equal(validateWeeklyColumnProfileInput(psInput).ok, false, "PS matrix firstColumn edit rejected");
}

export function runWeeklyColumnProfileStoreTests() {
  mergePrecedence();
  dbRowParsing();
  validationAllowsIndexEdit();
  validationRejectsUnsafeEdits();
}
