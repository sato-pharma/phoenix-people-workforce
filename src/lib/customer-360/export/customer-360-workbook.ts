import ExcelJS from "exceljs";

import { buildHouseCoverSheet, writeHouseTable, type CellValue, type TableColumn } from "@/lib/export/house-table-workbook";
import { HOUSE_MASTHEAD_ROWS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import { cairoDate, cairoDateTime } from "@/lib/format/cairo-datetime";
import { actualResultStatusLabel, marketingRequestStatusLabel } from "@/lib/marketing-requests/roi-labels";
import { sanitizeSheetName } from "@/lib/sales/sales-workbook-kit";

import { hubLineLabel, LINKED_PHARMACY_SOURCE_LABELS } from "../hub";
import { HUB_HAS_LABELS, type HubListFilters, type HubListRow } from "../list";
import type { HubView } from "../report";
import { monthLabel, VERDICT_LABELS } from "../verdict";

/**
 * Customer 360's Excel file — the same customers, scope and filters as the screen, in nine sheets
 * (owner, 2026-10-18: "the strongest report possible, a data source for the customers").
 *
 * 🔴 VALUE ONLY. Units of different products are never added, so no sheet carries a unit total.
 * 🔴 MONEY ONLY FOR MARKETING READERS. A viewer the screen hides the campaign money from gets a file
 *    with those columns left out, not blanked — a blank cost reads as a free campaign.
 */

const EGP = "#,##0";
const COUNT = "#,##0";

export type Customer360WorkbookInput = {
  hubs: HubView[];
  rows: HubListRow[];
  filters: HubListFilters;
  closedMonths: string[];
  lastMonths: string[];
  distributorNames: Record<string, string>;
  moneyVisible: boolean;
  builtAt: string;
  generatedAt: string;
  generatedBy: string;
};

function addTableSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  title: string,
  subtitle: string,
  columns: TableColumn[],
  rows: CellValue[][],
  emptyNote: string,
  generatedAt: string,
) {
  const sheet = workbook.addWorksheet(sanitizeSheetName(name), { properties: { defaultColWidth: 16 } });
  writeHouseMasthead(workbook, sheet, {
    columns: Math.max(4, columns.length),
    provenance: [`Generated ${cairoDateTime(generatedAt)}`, `${rows.length.toLocaleString("en-US")} ${rows.length === 1 ? "row" : "rows"}`],
    subtitle,
    title,
  });
  const start = HOUSE_MASTHEAD_ROWS + 2;
  writeHouseTable(sheet, start, {
    columns,
    note: rows.length === 0 ? emptyNote : undefined,
    rows,
    title,
  });
  sheet.views = [{ state: "frozen", xSplit: 1, ySplit: start + 1 }];
}

const place = (hub: HubView): string => [hub.place?.brickName, hub.place?.areaName, hub.place?.regionName].filter(Boolean).join(" · ");

export async function buildCustomer360Workbook(input: Customer360WorkbookInput): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const byId = new Map(input.hubs.map((hub) => [hub.id, hub]));
  const hubs = input.rows.map((row) => byId.get(row.id)).filter((hub): hub is HubView => Boolean(hub));
  const kindLabel = input.filters.kind === "doctor" ? "Doctors" : "Accounts";
  const recent = new Set(input.lastMonths);
  const money = input.moneyVisible;
  const range = input.closedMonths.length > 0 ? `${monthLabel(input.closedMonths[0]!)} to ${monthLabel(input.closedMonths[input.closedMonths.length - 1]!)}` : "None closed yet";
  const filterText = [
    input.filters.query ? `Search "${input.filters.query}"` : null,
    input.filters.line ? `Line ${input.filters.line}` : null,
    input.filters.area ? `Area ${input.filters.area}` : null,
    input.filters.verdict ? `Verdict ${VERDICT_LABELS[input.filters.verdict]}` : null,
    input.filters.has ? HUB_HAS_LABELS[input.filters.has] : null,
  ].filter(Boolean).join(" · ") || "None";
  const verdictCount = (verdict: keyof typeof VERDICT_LABELS) => input.rows.filter((row) => row.verdict === verdict).length;

  buildHouseCoverSheet(workbook, {
    confidentialNote: "CONFIDENTIAL — customer identities, visits, sales and marketing figures. Internal distribution only.",
    rows: [
      ["Customers", `${kindLabel} — ${input.rows.length.toLocaleString("en-US")} validated`],
      ["Filters", filterText],
      ["Who is in", "Validated customers only: validated Phoenix CRM doctors (PM) and accounts (AM), and validated marketing customers. The pharmacies tied to them need no validation."],
      ["Sales", `The Monthly Closing's own customer rows, closed months only, value only (${range}). January to June are the closing's uploaded figures from before publishing began.`],
      ["Whitelist", "Sales grew after the marketing request, even a little, or there were none before and there are sales after — or the linked pharmacies started selling or grew while the customer was visited."],
      ["Blacklist", "The return window has closed below ten times the cost, and the linked pharmacies sold no more than in the three months before."],
      ["Watch", "Money is spent and the window is still open with no rise yet, the evidence is mixed, or the customer is visited and the pharmacies are flat."],
      ["Advisory only", "The verdict never blocks or delays a marketing request."],
      ["Verdicts", `Whitelist ${verdictCount("whitelist")} · Watch ${verdictCount("watch")} · Blacklist ${verdictCount("blacklist")} · Not enough data ${verdictCount("not_enough_data")}`],
      ["Report built", cairoDateTime(input.builtAt)],
      ["Times shown in", "Africa/Cairo"],
      ["Generated", `${cairoDateTime(input.generatedAt)} by ${input.generatedBy}`],
    ],
    subtitle: "Every validated doctor and account, linked to its visits, pharmacies, marketing money and sales",
    title: "Customer 360",
  });

  // 1 · Customers
  addTableSheet(
    workbook,
    kindLabel,
    kindLabel,
    "One row per validated customer, in the screen's order",
    [
      { label: "Customer", width: 34 },
      { label: "Speciality", width: 18 },
      { label: "Grade", width: 8 },
      { label: "Brick · area · region", width: 32 },
      { label: "Validated on", width: 18 },
      { label: "Lines visiting", width: 22 },
      { label: "Pharmacies linked", numFmt: COUNT, right: true, width: 12 },
      { label: "Selling now", numFmt: COUNT, right: true, width: 10 },
      { label: "Named on visits", numFmt: COUNT, right: true, width: 10 },
      { label: "Marketing requests", numFmt: COUNT, right: true, width: 11 },
      ...(money ? [{ label: "Marketing money (EGP)", numFmt: EGP, right: true, width: 14 }] : []),
      { label: "Direct orders (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Sales, last 3 months (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Sales since January (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Verdict", width: 14 },
      { label: "Why", width: 60 },
    ],
    input.rows.map((row) => [
      row.name,
      row.speciality,
      row.grade,
      [row.brickName, row.areaName, row.regionName].filter(Boolean).join(" · "),
      row.validatedOnLines.join(", ") || "Marketing register",
      row.linesVisiting.join(", ") || "No visits on record",
      row.pharmacies,
      row.pharmaciesSelling,
      row.namedOnVisit,
      row.requests,
      ...(money ? [row.marketingCost ?? 0] : []),
      row.directOrderValue,
      row.salesLast3,
      row.salesTotal,
      `${row.verdictLabel}${row.early ? " (early)" : ""}`,
      row.headline,
    ]),
    "No validated customer matches these filters.",
    input.generatedAt,
  );

  // 2 · Pharmacy links
  addTableSheet(
    workbook,
    "Pharmacy links",
    "Pharmacy links",
    "Every pharmacy tied to each customer, how it was tied, and its closing value",
    [
      { label: "Customer", width: 30 },
      { label: "Pharmacy", width: 30 },
      { label: "How linked", width: 26 },
      { label: "Brick · area", width: 24 },
      { label: "Address", width: 34 },
      { label: "Distributors and codes", width: 40 },
      { label: "Last 3 months (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Since January (EGP)", numFmt: EGP, right: true, width: 14 },
    ],
    hubs.flatMap((hub) =>
      hub.pharmacies.map((pharmacy) => {
        const sales = hub.pharmacySales[pharmacy.key];
        const last3 = Object.entries(sales?.byMonth ?? {}).reduce((sum, [month, value]) => (recent.has(month) ? sum + value : sum), 0);
        return [
          hub.name,
          pharmacy.name,
          [
            ...pharmacy.sources.map((source) => LINKED_PHARMACY_SOURCE_LABELS[source]),
            pharmacy.matchStatus === "auto" ? "tied by the rule" : pharmacy.matchStatus === "confirmed" ? "confirmed by the administrator" : null,
          ].filter(Boolean).join(" · "),
          [pharmacy.brickName, pharmacy.areaName].filter(Boolean).join(" · "),
          pharmacy.address,
          pharmacy.pairs.map((pair) => `${input.distributorNames[pair.distributorCode] ?? "Unnamed distributor"} ${pair.customerCode}`).join(" · ") || "No distributor code",
          last3,
          sales?.total ?? 0,
        ];
      }),
    ),
    "None of these customers has a linked pharmacy yet.",
    input.generatedAt,
  );

  // 3 · Visits
  addTableSheet(
    workbook,
    "Visits",
    "Visits by line and month",
    "Phoenix CRM and iReports360 visits, by month, line and rep",
    [
      { label: "Customer", width: 30 },
      { label: "Month", width: 14 },
      { label: "Line", width: 14 },
      { label: "Rep", width: 26 },
      { label: "Source", width: 12 },
      { label: "AM visits", numFmt: COUNT, right: true, width: 9 },
      { label: "PM visits", numFmt: COUNT, right: true, width: 9 },
      { label: "Pharmacy calls", numFmt: COUNT, right: true, width: 10 },
      { label: "Regular", numFmt: COUNT, right: true, width: 9 },
      { label: "Campaign", numFmt: COUNT, right: true, width: 9 },
    ],
    hubs.flatMap((hub) =>
      [...hub.visits]
        .sort((left, right) => left.month.localeCompare(right.month))
        .map((visit) => [
          hub.name,
          monthLabel(visit.month),
          visit.line ? hubLineLabel(visit.line) : "Not recorded",
          visit.repName,
          visit.source === "phoenix" ? "Phoenix CRM" : "iReports360",
          visit.am,
          visit.pm,
          visit.pharmacies,
          visit.regular,
          visit.campaign,
        ]),
    ),
    "No visit is on record for these customers.",
    input.generatedAt,
  );

  // 4 · Marketing requests and ROI
  addTableSheet(
    workbook,
    "Marketing and ROI",
    "Marketing requests and their return",
    "The Marketing ROI engine's own figures, with the before and after monthly averages the verdict reads",
    [
      { label: "Customer", width: 30 },
      { label: "Request", width: 24 },
      { label: "Status", width: 14 },
      { label: "Marketing customer", width: 28 },
      { label: "Paid", width: 13 },
      { label: "Return window", width: 22 },
      ...(money
        ? [
            { label: "Cost (EGP)", numFmt: EGP, right: true, width: 12 },
            { label: "Target (EGP)", numFmt: EGP, right: true, width: 12 },
            { label: "Returned (EGP)", numFmt: EGP, right: true, width: 12 },
          ]
        : []),
      { label: "Result", width: 16 },
      { label: "Monthly average before (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Monthly average after (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Grew", width: 8 },
    ],
    hubs.flatMap((hub) =>
      hub.requests.map((request) => {
        const signal = hub.verdict.requests.find((one) => one.requestId === request.id);
        return [
          hub.name,
          request.typeName ?? "Marketing request",
          marketingRequestStatusLabel(request.status),
          request.marketingCustomerName,
          request.payDate ? cairoDate(request.payDate) : "Not paid yet",
          request.windowLabel,
          ...(money ? [request.cost, request.requiredRoi, request.actualRoi] : []),
          actualResultStatusLabel(request.roiResult),
          signal?.before ?? null,
          signal?.after ?? null,
          signal?.grew === null || signal?.grew === undefined ? "Not yet" : signal.grew ? "Yes" : "No",
        ];
      }),
    ),
    "No marketing request names these customers.",
    input.generatedAt,
  );

  // 5 · Direct orders
  addTableSheet(
    workbook,
    "Direct orders",
    "Direct orders",
    "Approved orders on the trusted direct-order pharmacies tied to each customer, by Finance's month",
    [
      { label: "Customer", width: 30 },
      { label: "Month", width: 14 },
      { label: "Value (EGP)", numFmt: EGP, right: true, width: 14 },
      { label: "Pharmacies", numFmt: COUNT, right: true, width: 10 },
      { label: "Orders in total", numFmt: COUNT, right: true, width: 10 },
    ],
    hubs.flatMap((hub) =>
      Object.entries(hub.directOrders.byMonth)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([month, value]) => [hub.name, monthLabel(month), value, hub.directOrders.venues, hub.directOrders.orders]),
    ),
    "No trusted direct-order pharmacy is tied to these customers.",
    input.generatedAt,
  );

  // 6 · Pharmacy sales by month
  addTableSheet(
    workbook,
    "Sales by month",
    "Pharmacy sales by month",
    "Each linked pharmacy's Monthly Closing value in every closed month",
    [
      { label: "Customer", width: 30 },
      { label: "Pharmacy", width: 30 },
      ...input.closedMonths.map((month) => ({ label: monthLabel(month), numFmt: EGP, right: true, width: 13 })),
      { label: "Total (EGP)", numFmt: EGP, right: true, width: 14 },
    ],
    hubs.flatMap((hub) =>
      hub.pharmacies
        .filter((pharmacy) => (hub.pharmacySales[pharmacy.key]?.total ?? 0) !== 0)
        .map((pharmacy) => {
          const sales = hub.pharmacySales[pharmacy.key];
          return [hub.name, pharmacy.name, ...input.closedMonths.map((month) => sales?.byMonth[month] ?? 0), sales?.total ?? 0];
        }),
    ),
    "No linked pharmacy has sales in a closed month.",
    input.generatedAt,
  );

  // 7 · Verdict reasons
  addTableSheet(
    workbook,
    "Verdict reasons",
    "Verdict reasons",
    "Every reason behind each verdict, in plain words",
    [
      { label: "Customer", width: 30 },
      { label: "Brick · area · region", width: 30 },
      { label: "Verdict", width: 16 },
      { label: "Reason", width: 90 },
    ],
    hubs.flatMap((hub) =>
      hub.verdict.reasons.map((reason) => [hub.name, place(hub), `${VERDICT_LABELS[hub.verdict.verdict]}${hub.verdict.early ? " (early)" : ""}`, reason]),
    ),
    "No verdict reason to show.",
    input.generatedAt,
  );

  // 8 · Not linked
  addTableSheet(
    workbook,
    "Not linked",
    "Not linked",
    "What could not be joined to a customer, and why",
    [
      { label: "Customer", width: 30 },
      { label: "Reason", width: 90 },
    ],
    hubs.flatMap((hub) => hub.notLinked.map((note) => [hub.name, note.reason])),
    "Everything found was linked.",
    input.generatedAt,
  );

  return workbook.xlsx.writeBuffer() as unknown as Promise<ArrayBuffer>;
}
