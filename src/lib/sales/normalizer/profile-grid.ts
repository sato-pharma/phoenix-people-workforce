import type { DistributorProfile } from "@/lib/sales/normalizer/types";

// The "Database Validation" header grid: for each distributor, which RAW column feeds each unified
// Phoenix header. A pure transform of the column profiles (code-defined today; DB-driven in a later
// phase) so the admin can SEE, per distributor, exactly how the Normalizer reads its sheet.
// Area ID / Region ID are derived from the Brick (never mapped); Distrub ID is the distributor's own code.

export type HeaderGridColumn = { key: string; label: string };
export type HeaderGridRow = { cells: Record<string, string>; distributorCode: string; distributorName: string };
export type HeaderGrid = { columns: HeaderGridColumn[]; rows: HeaderGridRow[] };

// Unified Phoenix headers shown as columns, in coded-sheet order.
export const HEADER_GRID_COLUMNS: HeaderGridColumn[] = [
  { key: "distrub", label: "Distrub ID" },
  { key: "region", label: "Region ID" },
  { key: "area", label: "Area ID" },
  { key: "brick", label: "Brick ID" },
  { key: "product", label: "Product ID" },
  { key: "qty", label: "Qty" },
  { key: "bonus", label: "B. Qty" },
  { key: "value", label: "Value" },
  { key: "discount", label: "Discount%" },
  { key: "date", label: "Invoice Date" },
  { key: "customer", label: "Customer" },
  { key: "customerName", label: "Customer Name" },
];

const join = (cols?: string[]) => (cols && cols.length ? cols.join(" / ") : "");

export function profilesToHeaderGrid(profiles: DistributorProfile[]): HeaderGrid {
  const rows: HeaderGridRow[] = profiles
    .slice()
    .sort((a, b) => a.distributorName.localeCompare(b.distributorName))
    .map((p) => {
      const brick = join(p.territoryColumns) || join(p.brickIdColumns) || (p.customerCodeColumns?.length ? "via Customer map" : "");
      return {
        cells: {
          distrub: p.distributorCode,
          region: "auto (from Brick)",
          area: "auto (from Brick)",
          brick: brick || "—",
          product: join(p.productColumns) || "—",
          qty: join(p.qtyColumns) || "—",
          bonus: join(p.bonusColumns) || "—",
          value: p.valueSource === "sheet" ? join(p.valueColumns) || "from sheet" : "auto (recompute)",
          discount: join(p.discountColumns) || "—",
          date: join(p.dateColumns) || "—",
          customer: join(p.customerCodeColumns) || "—",
          customerName: join(p.customerNameColumns) || "—",
        },
        distributorCode: p.distributorCode,
        distributorName: p.distributorName,
      };
    });
  return { columns: HEADER_GRID_COLUMNS, rows };
}
