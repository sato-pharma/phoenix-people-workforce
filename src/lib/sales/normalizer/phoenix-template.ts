// ── The Phoenix universal upload template ──────────────────────────────────────────────────────
//
// A ONE-LAYOUT sheet the business fills itself, for any distributor, and uploads through the same
// Source Normalizer pipeline every distributor file goes through. It is NOT a per-distributor
// emergency copy (that is `src/lib/sales/raw-template.ts`, which mimics one distributor's own
// export): this is Phoenix's own layout, the same every month, whoever the goods came from.
//
// The trick that makes it "exactly what happens with other distributors" is that the sheet NAMES
// its distributor and the recognizer RESOLVES that name back to a real distributor code, then hands
// the engine a profile carrying the template's headers under the REAL distributor's code. So every
// coded row is stamped with the real distributor, the customer crosswalk is keyed
// `${realDistributor} ${customerCode}` exactly as always, and the batch is filed under the real
// distributor — nothing downstream can tell the file came in on the template.
//
// This module is deliberately ExcelJS-light (no embedded brand image, no workbook building) so the
// recognizer can import it without dragging the base64 brand assets into the upload path. The
// workbook builder lives beside it in `phoenix-template-workbook.ts`.

import type ExcelJS from "exceljs";

import { buildHeaderMap, cellText } from "@/lib/sales/normalizer/engine";
import { normalizeHeaderKey } from "@/lib/sales/normalizer/header-normalize";
import { PHOENIX_TEMPLATE_CODE, PHOENIX_TEMPLATE_NAME } from "@/lib/sales/normalizer/phoenix-template-code";
import { normalizeAliasKey, normalizeCodeKey } from "@/lib/sales/normalizer/resolvers";
import type { DistributorProfile } from "@/lib/sales/normalizer/types";

// The sentinel code and its label live in `phoenix-template-code.ts` — a module light enough for the
// browser to import — and are re-exported here so the server keeps one import site for the template.
export { PHOENIX_TEMPLATE_CODE, PHOENIX_TEMPLATE_NAME, isPhoenixTemplateCode } from "@/lib/sales/normalizer/phoenix-template-code";

export const PHOENIX_TEMPLATE_SHEET = "Sales";
export const PHOENIX_TEMPLATE_DISTRIBUTORS_SHEET = "Distributors";
export const PHOENIX_TEMPLATE_PRODUCTS_SHEET = "Products";

export type TemplateColumnKind = "input" | "auto" | "helper";

export type TemplateColumn = {
  header: string;
  kind: TemplateColumnKind;
  /** Obligatory columns (owner's word) — the sheet is refused when one is missing. */
  required: boolean;
  width: number;
  note: string;
};

// Display order. The engine maps by header NAME, not position, so this order is presentation only —
// but it is the order the Read Me and the column reference describe, so keep them together.
export const PHOENIX_TEMPLATE_COLUMNS: TemplateColumn[] = [
  {
    header: "Distributor Name",
    kind: "input",
    required: true,
    width: 30,
    note: "Pick the distributor from the dropdown — Distributor Code fills in automatically. One distributor per file.",
  },
  {
    header: "Distributor Code",
    kind: "auto",
    required: false,
    width: 16,
    note: "AUTO from Distributor Name — do not type.",
  },
  {
    header: "Invoice Date",
    kind: "input",
    required: true,
    width: 14,
    note: "The invoice date (DD-MM-YYYY). The month decides which period the sale is booked in.",
  },
  {
    header: "Customer Code",
    kind: "input",
    required: true,
    width: 18,
    note: "The distributor's OWN code for the pharmacy / customer. This is what the system remembers the territory against.",
  },
  {
    header: "Customer Name",
    kind: "input",
    required: true,
    width: 34,
    note: "The customer's name exactly as the distributor writes it.",
  },
  {
    header: "Customer Address",
    kind: "input",
    required: true,
    width: 40,
    note: "The customer's address. The address is the first thing the system reads when it works out the brick.",
  },
  {
    header: "Territory / Area",
    kind: "input",
    required: false,
    width: 22,
    note: "Optional — the distributor's own area / district text, when the file has one. Helps place a brand-new customer.",
  },
  {
    header: "Product Name",
    kind: "input",
    required: true,
    width: 30,
    note: "Pick the product from the dropdown — Product Code fills in automatically.",
  },
  {
    header: "Product Code",
    kind: "auto",
    required: false,
    width: 14,
    note: "AUTO from Product Name — do not type.",
  },
  {
    header: "Quantity",
    kind: "input",
    required: true,
    width: 12,
    note: "Units sold. Value is computed as units x factory price, exactly as for every other distributor.",
  },
  {
    header: "Helper 1",
    kind: "helper",
    required: false,
    width: 20,
    note: "Yours to use for anything — invoice number, branch, a note. The system keeps it with the row and ignores it.",
  },
  {
    header: "Helper 2",
    kind: "helper",
    required: false,
    width: 20,
    note: "Yours to use for anything. The system keeps it with the row and ignores it.",
  },
];

const H = Object.fromEntries(PHOENIX_TEMPLATE_COLUMNS.map((c) => [c.header, c.header])) as Record<string, string>;

/** 1-based column indexes, derived from PHOENIX_TEMPLATE_COLUMNS order (the workbook builder's map). */
export const PHOENIX_TEMPLATE_COL = {
  distributorName: 1,
  distributorCode: 2,
  invoiceDate: 3,
  customerCode: 4,
  customerName: 5,
  customerAddress: 6,
  territory: 7,
  productName: 8,
  productCode: 9,
  quantity: 10,
  helper1: 11,
  helper2: 12,
} as const;

/**
 * The engine profile for a template file, carrying the REAL distributor's code and name.
 *
 * `valueSource: "recompute"` (units x factory price) and `dateFormat: "day-first"` match every
 * Egyptian distributor profile. `fingerprintColumns` are the four headers no distributor's own
 * export has, so a template file always out-scores every real profile and never draws a
 * "wrong distributor" warning.
 */
export function phoenixTemplateProfile(distributorCode: string, distributorName: string): DistributorProfile {
  return {
    distributorCode: normalizeCodeKey(distributorCode),
    distributorName,
    productColumns: [H["Product Code"], H["Product Name"]],
    productCodeColumns: [H["Product Code"]],
    productNameColumns: [H["Product Name"]],
    qtyColumns: [H.Quantity],
    valueColumns: [],
    valueSource: "recompute",
    dateColumns: [H["Invoice Date"]],
    dateFormat: "day-first",
    customerCodeColumns: [H["Customer Code"]],
    customerNameColumns: [H["Customer Name"]],
    customerAddressColumns: [H["Customer Address"]],
    territoryColumns: [H["Territory / Area"]],
    fingerprintColumns: [H["Distributor Name"], H["Distributor Code"], H["Helper 1"], H["Helper 2"]],
  };
}

/** Headers-only profile, used before the real distributor is known (sheet picking + detection). */
export const PHOENIX_TEMPLATE_BASE_PROFILE: DistributorProfile = phoenixTemplateProfile(
  PHOENIX_TEMPLATE_CODE,
  PHOENIX_TEMPLATE_NAME,
);

export type TemplateDistributorOption = { distributorCode: string; distributorName: string };

/** One distributor's share of a filled template. */
export type TemplateDistributorRun = {
  distributorCode: string;
  distributorName: string;
  /** Rows that NAMED this distributor. A row that names nobody carries the name above it down. */
  namedRows: number;
  /** Rows of sales credited to it, the carried-down ones included. */
  dataRows: number;
};

export type TemplateDistributorDetection =
  // `distributors` comes back in the order the sheet first names them, and `distributorByRow` says
  // which one owns each data row. The recognizer then runs the engine once per distributor over
  // that filter, so one filled file becomes one batch per distributor — exactly what uploading
  // each distributor's own sheet separately would have produced.
  | { ok: true; distributors: TemplateDistributorRun[]; distributorByRow: Map<number, string> }
  | { ok: false; message: string };

/** At most `limit` names, joined for a message — never an ellipsis (owner rule). */
function nameList(values: Iterable<string>, limit = 6): string {
  const all = [...values];
  const shown = all.slice(0, limit);
  const rest = all.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/**
 * Read the distributors off a filled template.
 *
 * Name-first, code as the fallback: the Distributor Code column is a VLOOKUP formula, and a row
 * pasted below the pre-wired block has no formula at all — so the NAME is the authority, and the
 * code only helps when somebody typed one by hand.
 *
 * SEVERAL distributors in one file are allowed (the owner's decision, 2026-09-18). The name carries
 * DOWN: write "Ibnsina" on the first row of its block, fill its rows, write the next distributor's
 * name, fill its rows. Each one still becomes its OWN batch, because a batch is one distributor and
 * one month everywhere else in the pipeline.
 *
 * Refused, with the names or the row numbers in the sentence: a distributor the system does not
 * know; a file naming none at all; and — only when the file carries several — sales rows
 * sitting above the first name, which belong to nobody. With one distributor there is nothing to be
 * ambiguous about, so those rows simply belong to it, exactly as before.
 */
export function detectTemplateDistributor(
  sheet: ExcelJS.Worksheet,
  distributors: readonly TemplateDistributorOption[],
): TemplateDistributorDetection {
  const byCode = new Map<string, TemplateDistributorOption>();
  const byName = new Map<string, TemplateDistributorOption>();
  for (const d of distributors) {
    const code = normalizeCodeKey(d.distributorCode);
    if (code) byCode.set(code, d);
    const name = normalizeAliasKey(d.distributorName);
    if (name) byName.set(name, d);
  }

  const header = buildHeaderMap(sheet, PHOENIX_TEMPLATE_BASE_PROFILE);
  const nameCol = header.col.get(normalizeHeaderKey(H["Distributor Name"]));
  const codeCol = header.col.get(normalizeHeaderKey(H["Distributor Code"]));
  if (!nameCol && !codeCol) {
    return {
      ok: false,
      message:
        'This file has no "Distributor Name" column, so it is not a Phoenix template. Download the template, paste the sales into it, and upload that — or pick the distributor by name instead.',
    };
  }

  // The columns that make a row a SALE rather than a pre-wired blank. The downloaded template ships
  // a thousand rows of dropdowns and VLOOKUP formulas, so every one of those rows HAS cell values:
  // asking whether a row holds anything at all would call the whole block data and hand every empty
  // row a distributor. When the sheet carries none of the four, fall back to the distributor cells
  // so the file is refused a moment later by header validation, which names the missing column.
  const dataCols = [H["Customer Code"], H["Customer Name"], H["Product Name"], H.Quantity]
    .map((h) => header.col.get(normalizeHeaderKey(h)))
    .filter((c): c is number => typeof c === "number");

  const order: string[] = [];
  const runs = new Map<string, TemplateDistributorRun>();
  const distributorByRow = new Map<number, string>();
  const unknown = new Set<string>();
  const orphanRows: number[] = [];
  let carried: TemplateDistributorOption | null = null;

  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    const rawName = nameCol ? cellText(row.getCell(nameCol)).trim() : "";
    const rawCode = codeCol ? cellText(row.getCell(codeCol)).trim() : "";
    if (rawName || rawCode) {
      const hit = byName.get(normalizeAliasKey(rawName)) ?? byCode.get(normalizeCodeKey(rawCode));
      if (!hit) { unknown.add(rawName || rawCode); continue; }
      carried = hit;
      const code = normalizeCodeKey(hit.distributorCode);
      let run = runs.get(code);
      if (!run) {
        run = { dataRows: 0, distributorCode: code, distributorName: hit.distributorName, namedRows: 0 };
        runs.set(code, run);
        order.push(code);
      }
      run.namedRows += 1;
    }

    const isData = dataCols.length > 0
      ? dataCols.some((c) => cellText(row.getCell(c)).trim() !== "")
      : Boolean(rawName || rawCode);
    if (!isData) continue;
    if (!carried) { orphanRows.push(r); continue; }
    const owner = normalizeCodeKey(carried.distributorCode);
    distributorByRow.set(r, owner);
    const run = runs.get(owner);
    if (run) run.dataRows += 1;
  }

  if (unknown.size > 0) {
    return {
      ok: false,
      message: `The template names a distributor the system does not know: ${nameList(unknown)}. Pick the distributor from the dropdown in the "Distributor Name" column rather than typing it.`,
    };
  }
  if (runs.size === 0) {
    return {
      ok: false,
      message:
        'No distributor is named in this template. Fill the "Distributor Name" column — pick from the dropdown — and upload again.',
    };
  }

  if (orphanRows.length > 0 && runs.size === 1) {
    const only = [...runs.values()][0];
    for (const r of orphanRows) { distributorByRow.set(r, only.distributorCode); only.dataRows += 1; }
    orphanRows.length = 0;
  }
  if (orphanRows.length > 0) {
    const shown = orphanRows.slice(0, 6);
    const rest = orphanRows.length - shown.length;
    const where = orphanRows.length === 1
      ? `row ${shown[0]}`
      : `rows ${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
    return {
      ok: false,
      message: `This file carries several distributors, and ${where} holds sales with no distributor named on it or anywhere above it. Write the distributor's name on the first row of each block.`,
    };
  }

  const withRows: TemplateDistributorRun[] = [];
  for (const code of order) {
    const run = runs.get(code);
    if (run && run.dataRows > 0) withRows.push(run);
  }
  if (withRows.length === 0) {
    return {
      ok: false,
      message: `The template names ${nameList([...runs.values()].map((run) => run.distributorName))} but carries no sales. Fill the customer, product and quantity columns and upload again.`,
    };
  }
  return { distributorByRow, distributors: withRows, ok: true };
}
