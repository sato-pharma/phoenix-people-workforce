// Weekly Sales — declarative column contract per distributor.
//
// This is a HUMAN-READABLE MIRROR of the column layout each adapter in `parser.ts` actually reads.
// It powers the pre-upload "Verification" step: we read the uploaded file's real header row and show
// the operator exactly which data the engine will take from which column, then let an AI sanity-check
// it for drift. It does NOT drive parsing — the adapters remain the source of truth — so when an
// adapter's columns change, update the matching block here too (line refs point back to parser.ts).
//
// Column indexes are 1-based ExcelJS columns, matching the adapters.

export type WeeklyContractFieldRole = "key" | "value" | "context";

export type WeeklyContractField = {
  /** machine key, e.g. "itemCode" */
  field: string;
  /** human label shown in the verification table, e.g. "Product code" */
  label: string;
  /** 1-based pinned column the adapter reads */
  columnIndex: number;
  /** what the header at that column usually reads (EN/AR) — the AI's drift reference */
  expectedHeaderHint: string;
  /** key = critical (drift here blocks "pass"); value = numeric measure; context = descriptive */
  role: WeeklyContractFieldRole;
};

export type WeeklyContractMatrixKind = "branch-headers" | "location-columns";

export type WeeklyContractMatrix = {
  /** branch-headers: each branch/outlet IS a column header (PS sales, RM stock).
   *  location-columns: each storage location is a column mapped by POSITION to a region (PS stock). */
  kind: WeeklyContractMatrixKind;
  /** first column of the matrix block (1-based) */
  firstColumn: number;
  /** optional hard last column; when omitted the block runs to the last non-empty header */
  lastColumn?: number;
  /** optional regex (source string, case-insensitive): stop the scan when a header matches it,
   *  WITHOUT counting that column. Mirrors adaptPS's "stop at Total Qty" boundary so the preview
   *  count matches what the parser actually reads. */
  stopAtHeaderPattern?: string;
  /** plain-English note shown to the operator */
  note: string;
};

export type WeeklyContractSheetRole = "combined" | "sales" | "returns" | "stock";

export type WeeklyContractSheet = {
  role: WeeklyContractSheetRole;
  /** preferred exact sheet name */
  sheetName?: string;
  /** fallback substring match when the exact name isn't found */
  sheetIncludes?: string;
  /** header row number (1-based): EG/IS/PS/SF = 1, RM/IS-S = 2 */
  headerRowNumber: number;
  /** which uploaded file carries this sheet (PS uses two files; everyone else one) */
  formField: "file" | "salesFile" | "stockFile";
  /** the pinned single-purpose columns */
  fields: WeeklyContractField[];
  /** for matrix sheets where branches/locations are spread across columns */
  matrix?: WeeklyContractMatrix;
};

export type WeeklyDistributorContract = {
  code: string;
  name: string;
  splitFiles: boolean;
  sheets: WeeklyContractSheet[];
};

// ── Per-distributor contracts (mirror of parser.ts adapters) ──────────────────────────────────────

const CONTRACTS: readonly WeeklyDistributorContract[] = [
  // EG / EGD — combined workbook, header row 1 (parser.ts adaptEG ~:200-294)
  {
    code: "EG",
    name: "EGD",
    splitFiles: false,
    sheets: [
      {
        role: "sales",
        sheetName: "Branches Sales",
        sheetIncludes: "Branches Sales",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "date", label: "Invoice date", columnIndex: 4, expectedHeaderHint: "date", role: "context" },
          { field: "itemCode", label: "Product code", columnIndex: 5, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 6, expectedHeaderHint: "item / product name", role: "context" },
          { field: "salesQty", label: "Sales quantity", columnIndex: 13, expectedHeaderHint: "sales quantity", role: "value" },
          { field: "branchCode", label: "Branch code", columnIndex: 29, expectedHeaderHint: "branch / customer code", role: "key" },
          { field: "branchName", label: "Branch name", columnIndex: 30, expectedHeaderHint: "branch / customer name", role: "context" },
        ],
      },
      {
        role: "returns",
        sheetName: "Branch Sales Return",
        sheetIncludes: "Return",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 5, expectedHeaderHint: "item / product code", role: "key" },
          { field: "returnQty", label: "Return quantity", columnIndex: 14, expectedHeaderHint: "return quantity", role: "value" },
          { field: "branchCode", label: "Branch code", columnIndex: 29, expectedHeaderHint: "branch / customer code", role: "key" },
        ],
      },
      {
        role: "stock",
        sheetName: "Current Stock Branches",
        sheetIncludes: "Stock",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 1, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 2, expectedHeaderHint: "item / product name", role: "context" },
          { field: "stockQty", label: "Stock quantity", columnIndex: 3, expectedHeaderHint: "stock / balance quantity", role: "value" },
          { field: "entityCode", label: "Branch code", columnIndex: 13, expectedHeaderHint: "branch / store code", role: "key" },
          { field: "entityName", label: "Branch name", columnIndex: 14, expectedHeaderHint: "branch / store name", role: "context" },
        ],
      },
    ],
  },
  // RM / RAMCO — combined workbook, header row 2 (parser.ts adaptRM ~:301-402)
  {
    code: "RM",
    name: "RAMCO",
    splitFiles: false,
    sheets: [
      {
        role: "sales",
        sheetName: "SALES",
        sheetIncludes: "SALES",
        headerRowNumber: 2,
        formField: "file",
        fields: [
          { field: "branchCode", label: "Branch code", columnIndex: 1, expectedHeaderHint: "branch code (numeric)", role: "key" },
          { field: "branchName", label: "Branch name", columnIndex: 2, expectedHeaderHint: "اسم الفرع / branch name", role: "context" },
          { field: "itemCode", label: "Product code", columnIndex: 9, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 10, expectedHeaderHint: "item / product name", role: "context" },
          { field: "gross", label: "Gross sales", columnIndex: 11, expectedHeaderHint: "بيع / sales quantity", role: "value" },
          { field: "return", label: "Return quantity", columnIndex: 13, expectedHeaderHint: "مرتجع بيع / sales return", role: "value" },
          { field: "net", label: "Net quantity (priced)", columnIndex: 15, expectedHeaderHint: "صافى كمية (authoritative net)", role: "value" },
          { field: "date", label: "Invoice date", columnIndex: 24, expectedHeaderHint: "date", role: "context" },
        ],
      },
      {
        role: "stock",
        sheetName: "STOCK",
        sheetIncludes: "STOCK",
        headerRowNumber: 2,
        formField: "file",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 4, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 6, expectedHeaderHint: "إسم الصنف / product name", role: "context" },
        ],
        matrix: {
          kind: "branch-headers",
          firstColumn: 7,
          stopAtHeaderPattern: "^(الإجمالى|الاجمالى|الإجمالي|الاجمالي)$",
          note: "Branch stock totals start at column 7 (first 'إجمالى <branch>' header). Col 6 is the product name. Scan runs until the grand total column (الإجمالى), which is excluded. Special channels (Key Accounts, Wholesale, Tenders, Warehouses) also use the 'إجمالى' prefix and are included when mapped.",
        },
      },
    ],
  },
  // IS-S / Ibn Sina Sato — single sheet, header row 2 (parser.ts adaptISS ~:406-440)
  {
    code: "IS-S",
    name: "Ibn Sina Sato",
    splitFiles: false,
    sheets: [
      {
        role: "combined",
        sheetName: "SalesAndStockReport2_DataHub",
        sheetIncludes: "DataHub",
        headerRowNumber: 2,
        formField: "file",
        fields: [
          { field: "date", label: "Date", columnIndex: 1, expectedHeaderHint: "date (auto-detected — no period needed)", role: "context" },
          { field: "itemCode", label: "Product code", columnIndex: 4, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 5, expectedHeaderHint: "item / product name", role: "context" },
          { field: "branchCode", label: "Branch code", columnIndex: 6, expectedHeaderHint: "branch code", role: "key" },
          { field: "branchName", label: "Branch name", columnIndex: 7, expectedHeaderHint: "branch name", role: "context" },
          { field: "stockQty", label: "Stock quantity", columnIndex: 8, expectedHeaderHint: "stock / balance quantity", role: "value" },
          { field: "signedSales", label: "Sales quantity (signed)", columnIndex: 10, expectedHeaderHint: "sales quantity (negative = return)", role: "value" },
        ],
      },
    ],
  },
  // IS / Ibn Sina ISP — single sheet "Sheet2", header row 1 (parser.ts adaptIS ~:444-476)
  {
    code: "IS",
    name: "Ibn Sina",
    splitFiles: false,
    sheets: [
      {
        role: "combined",
        sheetName: "Sheet2",
        sheetIncludes: "Sheet2",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 3, expectedHeaderHint: "item / product code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 4, expectedHeaderHint: "item / product name", role: "context" },
          { field: "branchCode", label: "Branch code", columnIndex: 5, expectedHeaderHint: "branch code", role: "key" },
          { field: "branchName", label: "Branch name", columnIndex: 6, expectedHeaderHint: "branch name", role: "context" },
          { field: "stockQty", label: "Stock quantity", columnIndex: 7, expectedHeaderHint: "stock / balance quantity", role: "value" },
          { field: "signedSales", label: "Sales quantity (signed)", columnIndex: 9, expectedHeaderHint: "sales quantity (negative = return). Free Unit col 10 is ignored", role: "value" },
        ],
      },
    ],
  },
  // SF / Sofico — single sheet "Sheet1", header row 1 (parser.ts adaptSF ~:625-668)
  {
    code: "SF",
    name: "Sofico",
    splitFiles: false,
    sheets: [
      {
        role: "combined",
        sheetName: "Sheet1",
        sheetIncludes: "Sheet1",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 4, expectedHeaderHint: "ItemID (Sofico code)", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 5, expectedHeaderHint: "ItemName", role: "context" },
          { field: "branchCode", label: "Branch code", columnIndex: 12, expectedHeaderHint: "State (branch numeric id)", role: "key" },
          { field: "branchName", label: "Branch name", columnIndex: 13, expectedHeaderHint: "statename (Arabic branch name)", role: "context" },
          { field: "gross", label: "Gross sales", columnIndex: 20, expectedHeaderHint: "SalesQty", role: "value" },
          { field: "return", label: "Return quantity", columnIndex: 22, expectedHeaderHint: "ReturnQty (positive). Bonus col 21 ignored", role: "value" },
          { field: "net", label: "Net sales (priced)", columnIndex: 24, expectedHeaderHint: "NET SALES (authoritative net)", role: "value" },
        ],
      },
    ],
  },
  // POS / POS Purchasing Sales — single matrix sheet "Purchasing Sales Data", header row 1.
  // Unique interleaved layout: every product occupies TWO consecutive rows — the first row holds
  // quantities per channel (col 4 onwards), the second row holds the corresponding EGP values
  // (ignored by the adapter; factory_price is used instead). Returns are encoded as negative
  // quantities in the qty row. The "Total" column and "Total Bonus" column at the right edge are
  // detected dynamically and excluded from the channel matrix scan.
  {
    code: "POS",
    name: "POS Purchasing Sales",
    splitFiles: false,
    sheets: [
      {
        role: "combined",
        sheetName: "Purchasing Sales Data",
        sheetIncludes: "Purchasing",
        headerRowNumber: 1,
        formField: "file",
        fields: [
          { field: "itemName", label: "Product name (Arabic)", columnIndex: 2, expectedHeaderHint: "product name — Arabic (col B)", role: "context" },
          { field: "itemCode", label: "Product code", columnIndex: 3, expectedHeaderHint: "Product Code", role: "key" },
          { field: "bonusQty", label: "Total bonus units", columnIndex: 109, expectedHeaderHint: "Total Bonus", role: "value" },
        ],
        matrix: {
          kind: "branch-headers",
          firstColumn: 4,
          stopAtHeaderPattern: "^total$",
          note: "Each customer / channel is a column header (cols 4 onward). The adapter reads the qty row for each product and skips the immediately following value row. The 'Total' and 'Total Bonus' columns at the right edge are excluded automatically.",
        },
      },
    ],
  },
  // PS / Overseas — TWO matrix files, header row 1 (parser.ts adaptPS ~:499-617)
  {
    code: "PS",
    name: "Overseas",
    splitFiles: true,
    sheets: [
      {
        role: "sales",
        sheetName: "Data",
        sheetIncludes: "Data",
        headerRowNumber: 1,
        formField: "salesFile",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 3, expectedHeaderHint: "Mat. Code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 4, expectedHeaderHint: "Mat. Desc.", role: "context" },
        ],
        matrix: {
          kind: "branch-headers",
          firstColumn: 5,
          stopAtHeaderPattern: "total\\s*qty",
          note: "Each outlet / branch IS a column header; the cell holds that outlet's NET quantity. The block runs from column 5 up to (but not including) the 'Total Qty' summary column, which is detected automatically.",
        },
      },
      {
        role: "stock",
        sheetName: "Data",
        sheetIncludes: "Data",
        headerRowNumber: 1,
        formField: "stockFile",
        fields: [
          { field: "itemCode", label: "Product code", columnIndex: 3, expectedHeaderHint: "Mat. Code", role: "key" },
          { field: "itemName", label: "Product name", columnIndex: 4, expectedHeaderHint: "Mat. Desc.", role: "context" },
        ],
        matrix: {
          kind: "location-columns",
          firstColumn: 7,
          note: "Each storage location is a column, mapped to a region BY POSITION (column index), so column order must match the saved location mapping. The block runs from column 7 to the last non-empty location header.",
        },
      },
    ],
  },
];

export function weeklyContractByCode(code: string | null | undefined): WeeklyDistributorContract | undefined {
  const key = String(code ?? "").trim().toUpperCase();
  return CONTRACTS.find((contract) => contract.code.toUpperCase() === key);
}

/** The full set of code-defined (default) weekly contracts. The DB override store overlays these. */
export function listCodeWeeklyContracts(): readonly WeeklyDistributorContract[] {
  return CONTRACTS;
}
