export type SourceOfSalesValidationIssue = {
  field?: unknown;
  message?: unknown;
  rowNumber?: unknown;
  severity?: unknown;
  value?: unknown;
};

export type SourceOfSalesWarningRow = {
  areaCode: string | null;
  areaName: string | null;
  brickId: string | null;
  clientCode: string | null;
  clientName: string | null;
  distributorCode: string;
  id: number;
  invoicePeriod: string | null;
  productCode: string;
  productName: string;
  rawRow: Record<string, unknown>;
  regionCode: string;
  regionName: string;
  rowNumber: number | null;
  validationIssues: SourceOfSalesValidationIssue[];
};

export type SourceOfSalesReferenceData = {
  areas: Array<{ areaCode: string; areaName: string; regionCode: string }>;
  bricks: Array<{ areaCode: string; brickId: string; regionCode: string }>;
  distributors: Array<{ distributorCode: string; distributorName: string }>;
  products: Array<{ line: string; productCode: string; productName: string }>;
  regions: Array<{ regionCode: string; regionName: string }>;
};

export type SourceOfSalesWarningCategory =
  | "area"
  | "brick"
  | "customer"
  | "distributor"
  | "other"
  | "product_name"
  | "region";

export type SourceOfSalesWarningGroup = {
  category: SourceOfSalesWarningCategory;
  count: number;
  distributorCode: string;
  field: string;
  invoicePeriod: string;
  message: string;
  sampleIds: number[];
};

export type SourceOfSalesWarningExport = {
  areaRows: Array<Record<string, string | number>>;
  brickRows: Array<Record<string, string | number>>;
  customerRows: Array<Record<string, string | number>>;
  distributorRows: Array<Record<string, string | number>>;
  productNameRows: Array<Record<string, string | number>>;
  rawSamples: Array<Record<string, string | number>>;
  regionRows: Array<Record<string, string | number>>;
  summaryRows: SourceOfSalesWarningGroup[];
};

export type RevalidatedSourceOfSalesRow = {
  id: number;
  validationIssues: SourceOfSalesValidationIssue[];
  validationState: "valid" | "warning";
};

function text(value: unknown) {
  return String(value ?? "").trim();
}

function toTextValue(value: unknown) {
  const output = text(value);
  return output === "null" || output === "undefined" ? "" : output;
}

export function normalizeSourceOfSalesCode(value: unknown) {
  return text(value).toUpperCase();
}

export function normalizeSourceOfSalesKey(value: unknown) {
  return text(value).toLowerCase().replace(/\s+/g, " ");
}

function issueField(issue: SourceOfSalesValidationIssue) {
  return text(issue.field || "Unknown");
}

function issueMessage(issue: SourceOfSalesValidationIssue) {
  return text(issue.message || "No message");
}

export function classifySourceOfSalesWarning(issue: SourceOfSalesValidationIssue): SourceOfSalesWarningCategory {
  const field = issueField(issue).toLowerCase();
  const message = issueMessage(issue).toLowerCase();
  if (field.includes("product name") || message.includes("product name is different")) return "product_name";
  if (field.includes("area") || message.includes("area code")) return "area";
  if (field.includes("region") || message.includes("region code") || message.includes("region name")) return "region";
  if (field.includes("brick") || message.includes("brick id")) return "brick";
  if (field.includes("distributor") || message.includes("distributor code")) return "distributor";
  if (field.includes("customer") || field.includes("client") || message.includes("customer")) return "customer";
  return "other";
}

function compactKey(parts: unknown[]) {
  return parts.map((part) => text(part)).join("\u0000");
}

function pushGrouped(
  map: Map<string, Record<string, string | number>>,
  keyParts: unknown[],
  base: Record<string, string | number>,
  rowId: number,
) {
  const key = compactKey(keyParts);
  const existing = map.get(key);
  if (existing) {
    existing.count = Number(existing.count) + 1;
    if (!String(existing.sample_ids).split(", ").includes(String(rowId))) {
      const ids = String(existing.sample_ids).split(", ").filter(Boolean);
      if (ids.length < 10) ids.push(String(rowId));
      existing.sample_ids = ids.join(", ");
    }
    return;
  }
  map.set(key, { ...base, count: 1, sample_ids: String(rowId) });
}

export function buildSourceOfSalesWarningExport(rows: SourceOfSalesWarningRow[]): SourceOfSalesWarningExport {
  const summary = new Map<string, SourceOfSalesWarningGroup>();
  const productNameRows = new Map<string, Record<string, string | number>>();
  const areaRows = new Map<string, Record<string, string | number>>();
  const regionRows = new Map<string, Record<string, string | number>>();
  const brickRows = new Map<string, Record<string, string | number>>();
  const distributorRows = new Map<string, Record<string, string | number>>();
  const customerRows = new Map<string, Record<string, string | number>>();
  const rawSamples: SourceOfSalesWarningExport["rawSamples"] = [];

  for (const row of rows) {
    const issues = row.validationIssues.length > 0 ? row.validationIssues : [{ field: "Unknown", message: "warning row has no issue detail" }];
    for (const issue of issues) {
      const category = classifySourceOfSalesWarning(issue);
      const field = issueField(issue);
      const message = issueMessage(issue);
      const period = row.invoicePeriod || "Unassigned";
      const summaryKey = compactKey([category, field, message, row.distributorCode, period]);
      const existing = summary.get(summaryKey);
      if (existing) {
        existing.count += 1;
        if (existing.sampleIds.length < 10) existing.sampleIds.push(row.id);
      } else {
        summary.set(summaryKey, {
          category,
          count: 1,
          distributorCode: row.distributorCode,
          field,
          invoicePeriod: period,
          message,
          sampleIds: [row.id],
        });
      }

      if (category === "product_name") {
        pushGrouped(
          productNameRows,
          [row.productCode, row.productName, row.distributorCode, period, message],
          {
            cleanup_policy: "trusted_product_code_wins",
            distributor_code: row.distributorCode,
            invoice_period: period,
            next_step: "No product-name correction is required when the trusted product_code exists in the master.",
            official_product_name: parseReferenceName(message, "product source table") || "",
            product_code: row.productCode,
            uploaded_product_name: toTextValue(issue.value) || row.productName,
            warning_message: message,
          },
          row.id,
        );
      } else if (category === "area") {
        pushGrouped(
          areaRows,
          [row.areaCode, row.areaName, row.regionCode, row.regionName, row.distributorCode, period, message],
          {
            approved_action: "",
            area_code: row.areaCode || "",
            area_name: row.areaName || "",
            distributor_code: row.distributorCode,
            inferred_region_code: row.regionCode,
            inferred_region_name: row.regionName,
            invoice_period: period,
            warning_message: message,
          },
          row.id,
        );
      } else if (category === "region") {
        pushGrouped(
          regionRows,
          [row.regionCode, row.regionName, row.distributorCode, period, message],
          {
            approved_action: "",
            distributor_code: row.distributorCode,
            invoice_period: period,
            region_code: row.regionCode,
            region_name: row.regionName,
            warning_message: message,
          },
          row.id,
        );
      } else if (category === "brick") {
        pushGrouped(
          brickRows,
          [row.brickId, row.areaCode, row.regionCode, row.distributorCode, period, message],
          {
            approved_action: "",
            area_code: row.areaCode || "",
            brick_id: row.brickId || "",
            distributor_code: row.distributorCode,
            invoice_period: period,
            region_code: row.regionCode,
            warning_message: message,
          },
          row.id,
        );
      } else if (category === "distributor") {
        pushGrouped(
          distributorRows,
          [row.distributorCode, period, message],
          {
            approved_action: "",
            distributor_code: row.distributorCode,
            invoice_period: period,
            warning_message: message,
          },
          row.id,
        );
      } else if (category === "customer") {
        pushGrouped(
          customerRows,
          [row.distributorCode, row.clientCode, row.clientName, period, message],
          {
            approved_action: "",
            client_code: row.clientCode || "",
            client_name: row.clientName || "",
            distributor_code: row.distributorCode,
            invoice_period: period,
            warning_message: message,
          },
          row.id,
        );
      }

      if (rawSamples.length < 1000) {
        rawSamples.push({
          area_code: row.areaCode || "",
          brick_id: row.brickId || "",
          category,
          client_code: row.clientCode || "",
          distributor_code: row.distributorCode,
          issue_field: field,
          issue_message: message,
          product_code: row.productCode,
          product_name: row.productName,
          region_code: row.regionCode,
          row_id: row.id,
          row_number: row.rowNumber || "",
        });
      }
    }
  }

  return {
    areaRows: [...areaRows.values()].sort(sortByCount),
    brickRows: [...brickRows.values()].sort(sortByCount),
    customerRows: [...customerRows.values()].sort(sortByCount),
    distributorRows: [...distributorRows.values()].sort(sortByCount),
    productNameRows: [...productNameRows.values()].sort(sortByCount),
    rawSamples,
    regionRows: [...regionRows.values()].sort(sortByCount),
    summaryRows: [...summary.values()].sort((left, right) => right.count - left.count || left.category.localeCompare(right.category)),
  };
}

function sortByCount(left: Record<string, string | number>, right: Record<string, string | number>) {
  return Number(right.count) - Number(left.count);
}

function parseReferenceName(message: string, marker: string) {
  const match = message.match(new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(([^)]+)\\)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function warning(field: string, value: unknown, message: string): SourceOfSalesValidationIssue {
  return {
    field,
    message,
    severity: "warning",
    value: text(value) || null,
  };
}

export function revalidateSourceOfSalesWarningRow(
  row: SourceOfSalesWarningRow,
  references: SourceOfSalesReferenceData,
): RevalidatedSourceOfSalesRow {
  const products = new Map(references.products.map((item) => [normalizeSourceOfSalesCode(item.productCode), item]));
  const regions = new Map(references.regions.map((item) => [normalizeSourceOfSalesCode(item.regionCode), item]));
  const areas = new Map(references.areas.map((item) => [normalizeSourceOfSalesCode(item.areaCode), item]));
  const bricks = new Map(references.bricks.map((item) => [normalizeSourceOfSalesCode(item.brickId), item]));
  const distributors = new Map(references.distributors.map((item) => [normalizeSourceOfSalesCode(item.distributorCode), item]));

  const issues: SourceOfSalesValidationIssue[] = [];
  const distributorCode = normalizeSourceOfSalesCode(row.distributorCode);
  const productCode = normalizeSourceOfSalesCode(row.productCode);
  const regionCode = normalizeSourceOfSalesCode(row.regionCode);
  const areaCode = normalizeSourceOfSalesCode(row.areaCode);
  const brickId = normalizeSourceOfSalesCode(row.brickId);

  const product = products.get(productCode);
  const region = regions.get(regionCode);
  const area = areas.get(areaCode);
  const brick = bricks.get(brickId);

  if (distributorCode && !distributors.has(distributorCode)) {
    issues.push(warning("Distributor Code", row.distributorCode, `Distributor Code ${distributorCode} is not in the distributor source-of-truth table.`));
  }
  if (productCode && !product) {
    issues.push(warning("Product Code", row.productCode, `Product Code ${productCode} is not in the product source-of-truth table.`));
  }
  // Product-name differences are distributor aliases. Once a row resolves to a trusted
  // Phoenix product_code, analytics use the master product and the alias must not keep the row in warning.
  if (regionCode && !region) {
    issues.push(warning("Region ID", row.regionCode, `Region Code ${regionCode} is not in the area/region source-of-truth table.`));
  }
  if (areaCode && !area) {
    issues.push(warning("Area ID", row.areaCode, `Area Code ${areaCode} is not in the area source-of-truth table. Uploaded code is kept for allocation.`));
  }
  if (brickId && !brick) {
    issues.push(warning("Brick ID", row.brickId, `Brick ID ${brickId} is not in the brick source-of-truth table. Uploaded code is kept for allocation.`));
  }
  if (region && normalizeSourceOfSalesKey(row.regionName) !== normalizeSourceOfSalesKey(region.regionName)) {
    issues.push(warning(
      "Region Name",
      row.regionName,
      `Region Name is different from the source table (${region.regionName}) for Region Code ${regionCode}. Uploaded code is kept for allocation.`,
    ));
  }
  if (area && regionCode && normalizeSourceOfSalesCode(area.regionCode) !== regionCode) {
    issues.push(warning(
      "Area ID",
      row.areaCode,
      `Area Code ${areaCode} belongs to Region Code ${area.regionCode} in the source table, but the upload says ${regionCode}. Uploaded hierarchy is kept.`,
    ));
  }
  if (brick && areaCode && normalizeSourceOfSalesCode(brick.areaCode) !== areaCode) {
    issues.push(warning(
      "Brick ID",
      row.brickId,
      `Brick ID ${brickId} belongs to Area Code ${brick.areaCode} in the source table, but the upload says ${areaCode}. Uploaded hierarchy is kept.`,
    ));
  }

  return {
    id: row.id,
    validationIssues: issues,
    validationState: issues.length > 0 ? "warning" : "valid",
  };
}

export function summarizeRevalidation(rows: RevalidatedSourceOfSalesRow[]) {
  return rows.reduce(
    (summary, row) => {
      summary.total += 1;
      if (row.validationState === "valid") summary.valid += 1;
      else summary.warning += 1;
      return summary;
    },
    { total: 0, valid: 0, warning: 0 },
  );
}
