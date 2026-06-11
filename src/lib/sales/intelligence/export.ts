import { buildPhoenixTableWorkbook, type ExportColumn, type ExportRow } from "@/lib/export/table-workbook";
import { type SalesAccessScope } from "@/lib/sales/access-scope";
import {
  aggregateByArea,
  aggregateByDistributor,
  aggregateByProduct,
  aggregateByRegion,
  aggregateCustomers,
  displayName,
  geographicRows,
} from "@/lib/sales/intelligence/derive";
import { loadSiCustomers, loadSiDistProduct, loadSiReference } from "@/lib/sales/intelligence/loader";

// Server-side export builder. CRUCIALLY, it re-loads the rows through the scoped loaders (which
// exclude restricted products and apply line/region scope) — it never trusts client-supplied
// rows — so a tampered request cannot export LA003/LA004 or another line's data.

export type SiExportTable = "transactions" | "products" | "distributors" | "regions" | "areas" | "customers";

const VALID_TABLES: SiExportTable[] = ["transactions", "products", "distributors", "regions", "areas", "customers"];

export function isSiExportTable(value: unknown): value is SiExportTable {
  return typeof value === "string" && (VALID_TABLES as string[]).includes(value);
}

const moneyCol = (key: string, label: string): ExportColumn => ({ key, label, numeric: true });

export async function buildSiExportWorkbook(
  table: SiExportTable,
  period: string | null,
  scope: SalesAccessScope,
) {
  const reference = await loadSiReference();
  const periodLabel = period ?? "all-validated";
  const restricted = scope.excludedProductCodes.length === 0 ? " (incl. Lacto Basic)" : "";

  let columns: ExportColumn[] = [];
  let rows: ExportRow[] = [];
  let title = "Sales Intelligence";

  if (table === "customers") {
    const customers = aggregateCustomers(await loadSiCustomers(period, scope, reference), reference, 1000);
    title = "Sales Intelligence — Customers";
    columns = [
      { key: "customer", label: "Customer" },
      { key: "brick", label: "Brick" },
      { key: "distributor", label: "Distributor" },
      moneyCol("value", "Value"),
      moneyCol("units", "Units"),
      moneyCol("share", "Share %"),
    ];
    rows = customers.customers.map((customer) => ({
      customer: customer.name,
      brick: customer.brick,
      distributor: customer.distributorName,
      value: customer.value,
      units: customer.units,
      share: Number((customer.share * 100).toFixed(1)),
    }));
  } else {
    const distProduct = await loadSiDistProduct(period, scope, reference);
    if (table === "transactions") {
      title = "Sales Intelligence — Transactions";
      columns = [
        { key: "distributor", label: "Distributor" },
        { key: "line", label: "Line" },
        { key: "region", label: "Region" },
        { key: "area", label: "Area" },
        { key: "product", label: "Product" },
        moneyCol("units", "Units"),
        moneyCol("value", "Value"),
      ];
      rows = distProduct
        .map((row) => ({
          distributor: displayName(reference.distributorName, row.distributorCode, "Unmapped distributor"),
          line: row.officialLine,
          region: displayName(reference.regionName, row.regionCode, "Unmapped region"),
          area: displayName(reference.areaName, row.areaCode, "Unmapped area"),
          product: row.productName || row.productCode,
          units: Number(row.units.toFixed(2)),
          value: Number(row.value.toFixed(2)),
        }))
        .sort((left, right) => right.value - left.value);
    } else if (table === "products") {
      title = "Sales Intelligence — Products";
      columns = [
        { key: "product", label: "Product" },
        { key: "line", label: "Line" },
        moneyCol("value", "Value"),
        moneyCol("units", "Units"),
        moneyCol("share", "Share %"),
      ];
      rows = aggregateByProduct(distProduct).map((product) => ({
        product: product.name,
        line: product.officialLine,
        value: product.value,
        units: product.units,
        share: Number((product.share * 100).toFixed(1)),
      }));
    } else if (table === "distributors") {
      title = "Sales Intelligence — Distributors";
      columns = [
        { key: "distributor", label: "Distributor" },
        moneyCol("value", "Value"),
        moneyCol("units", "Units"),
        moneyCol("share", "Share %"),
      ];
      rows = aggregateByDistributor(distProduct, reference).map((distributor) => ({
        distributor: distributor.name,
        value: distributor.value,
        units: distributor.units,
        share: Number((distributor.share * 100).toFixed(1)),
      }));
    } else if (table === "regions") {
      title = "Sales Intelligence — Regions";
      columns = [
        { key: "region", label: "Region" },
        moneyCol("value", "Value"),
        moneyCol("units", "Units"),
        moneyCol("share", "Share %"),
      ];
      rows = aggregateByRegion(geographicRows(distProduct), reference).map((region) => ({
        region: region.name,
        value: region.value,
        units: region.units,
        share: Number((region.share * 100).toFixed(1)),
      }));
    } else {
      title = "Sales Intelligence — Areas";
      columns = [
        { key: "area", label: "Area" },
        { key: "region", label: "Region" },
        moneyCol("value", "Value"),
        moneyCol("units", "Units"),
        moneyCol("share", "Share %"),
      ];
      rows = aggregateByArea(geographicRows(distProduct), reference).map((area) => ({
        area: area.name,
        region: area.regionName,
        value: area.value,
        units: area.units,
        share: Number((area.share * 100).toFixed(1)),
      }));
    }
  }

  return buildPhoenixTableWorkbook({
    title,
    subtitle: `Period: ${periodLabel}${restricted} · Generated by Phoenix Sales Intelligence`,
    sheetName: table,
    columns,
    rows,
  });
}
